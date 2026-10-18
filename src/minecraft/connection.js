// Persistent RCON connection per Minecraft server: a strict FIFO command
// queue, lazy (re)connect and exponential backoff after failed connects.
import { RconClient, RconError } from './rcon.js';

// Wait before the next connect attempt after the 1st, 2nd, ... consecutive failure.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

const isThenable = (value) => typeof value?.then === 'function';

// One server. Commands run one at a time in submission order. Backoff applies
// only to failures to CONNECT (including AUTH_FAILED): a command that dies
// because the connection dropped (CLOSED) or timed out (TIMEOUT) does not slow
// down the next exec, which reconnects at once.
//
// Options: { host, port, password, timeoutMs, now }, where `now` is the clock
// used for backoff (injectable for tests). Instead of host/port/password you
// may pass `lateConfig`, a promise of { host, port, password } that is awaited
// on the first connect (used by ConnectionManager for async resolvers).
export class ServerConnection {
  #options;
  #now;
  #client = null;
  #queue = [];
  #running = false;
  #state = 'idle'; // idle | connecting | ready | error
  #epoch = 0; // bumped by close(), so a connect aborted by close() is not a failure
  #failures = 0;
  #retryAt = 0;
  #lastError = null;

  constructor({ now = Date.now, ...options }) {
    this.#now = now;
    this.#options = options;
    if (!options.lateConfig) this.#client = this.#createClient(options);
  }

  // 'error' only while in backoff; once the delay has passed the next exec retries.
  get state() {
    if (this.#state === 'error' && this.#now() >= this.#retryAt) return 'idle';
    return this.#state;
  }

  exec(cmd) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ cmd, resolve, reject });
      this.#pump();
    });
  }

  // Rejects queued and in-flight commands with CLOSED and drops the socket. A
  // later exec() connects again, with a clean backoff slate.
  close() {
    this.#epoch += 1;
    this.#failures = 0;
    this.#retryAt = 0;
    this.#lastError = null;
    this.#state = 'idle';
    const queued = this.#queue.splice(0);
    for (const job of queued) job.reject(new RconError('CLOSED', 'Connection closed'));
    this.#client?.close();
  }

  #createClient({ host, port, password, timeoutMs }) {
    const client = new RconClient({ host, port, password, timeoutMs, keepAlive: true });
    client.on('close', () => {
      if (this.#state === 'ready') this.#state = 'idle';
    });
    return client;
  }

  async #pump() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift();
        try {
          const client = await this.#connect();
          job.resolve(await client.exec(job.cmd));
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #connect() {
    if (this.#state === 'ready') return this.#client;
    if (this.#lastError && this.#now() < this.#retryAt) {
      const last = this.#lastError;
      throw new RconError(last.code, last.message, { cause: last });
    }
    const epoch = this.#epoch;
    this.#state = 'connecting';
    try {
      this.#client ??= this.#createClient({ ...this.#options, ...(await this.#options.lateConfig) });
      if (epoch !== this.#epoch) throw new RconError('CLOSED', 'Connection closed');
    } catch (err) {
      // Not a connect failure (config could not be resolved, or close() won): no backoff.
      if (epoch === this.#epoch) this.#state = 'idle';
      throw err;
    }
    try {
      await this.#client.connect();
    } catch (err) {
      if (epoch === this.#epoch) this.#startBackoff(err);
      throw err;
    }
    this.#failures = 0;
    this.#lastError = null;
    this.#state = 'ready';
    return this.#client;
  }

  #startBackoff(err) {
    const delay = BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length - 1)];
    this.#failures += 1;
    this.#lastError = err;
    this.#retryAt = this.#now() + delay;
    this.#state = 'error';
  }
}

function connectionOptions(server, id) {
  if (!server) {
    throw Object.assign(new Error(`Server ${id} not found`), { code: 'NOT_FOUND' });
  }
  return { host: server.host, port: server.rcon_port, password: server.password };
}

// Lazy, cached ServerConnection per server id. `resolveServer(id)` returns (or
// resolves to) { host, rcon_port, password }, or null/undefined if unknown.
export class ConnectionManager {
  #resolveServer;
  #connectionOptions;
  #connections = new Map();

  // connectionOptions: extra ServerConnection options (timeoutMs, now).
  constructor(resolveServer, connectionOptions = {}) {
    this.#resolveServer = resolveServer;
    this.#connectionOptions = connectionOptions;
  }

  // Throws NOT_FOUND for an unknown id when resolveServer is synchronous. With an
  // async resolver the connection is returned at once and the first exec()
  // rejects with NOT_FOUND (the entry is then forgotten so a later get retries).
  get(id) {
    const cached = this.#connections.get(id);
    if (cached) return cached;
    const resolved = this.#resolveServer(id);
    let connection;
    if (isThenable(resolved)) {
      const lateConfig = Promise.resolve(resolved).then((server) => connectionOptions(server, id));
      lateConfig.catch(() => {
        if (this.#connections.get(id) === connection) this.#connections.delete(id);
      });
      connection = new ServerConnection({ ...this.#connectionOptions, lateConfig });
    } else {
      connection = new ServerConnection({
        ...this.#connectionOptions,
        ...connectionOptions(resolved, id),
      });
    }
    this.#connections.set(id, connection);
    return connection;
  }

  // Closes and forgets one server's connection (after it was edited or deleted).
  invalidate(id) {
    const connection = this.#connections.get(id);
    this.#connections.delete(id);
    connection?.close();
  }

  closeAll() {
    const all = [...this.#connections.values()];
    this.#connections.clear();
    for (const connection of all) connection.close();
  }
}
