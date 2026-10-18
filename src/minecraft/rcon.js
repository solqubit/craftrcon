// Source RCON client for Minecraft (node:net, no dependencies).
//
// Packet: int32LE length | int32LE id | int32LE type | body (UTF-8) | 0x00 0x00
// where `length` counts everything after itself (10 + body bytes).
import net from 'node:net';
import { EventEmitter } from 'node:events';

const TYPE_RESPONSE_VALUE = 0;
const TYPE_EXEC = 2; // SERVERDATA_EXECCOMMAND, also SERVERDATA_AUTH_RESPONSE
const TYPE_AUTH = 3;
const AUTH_FAILED_ID = -1;
const MAX_PACKET_LENGTH = 65_536; // vanilla never sends more than ~4 KiB
const MAX_REQUEST_ID = 2 ** 31 - 2; // leaves room for the sentinel id + 1
const KEEPALIVE_DELAY_MS = 30_000;

const SOCKET_ERROR_CODES = {
  ECONNREFUSED: 'ECONNREFUSED',
  ETIMEDOUT: 'ETIMEDOUT',
  EHOSTUNREACH: 'EHOSTUNREACH',
  ENETUNREACH: 'EHOSTUNREACH',
  ENOTFOUND: 'ENOTFOUND',
  EAI_AGAIN: 'ENOTFOUND',
};

export class RconError extends Error {
  // code: ECONNREFUSED | ETIMEDOUT | EHOSTUNREACH | ENOTFOUND | AUTH_FAILED | CLOSED | TIMEOUT
  constructor(code, message, options) {
    super(message ?? code, options);
    this.name = 'RconError';
    this.code = code;
  }
}

// Unknown socket errors become CLOSED; the original error stays in `cause`.
function fromSocketError(err) {
  const code = SOCKET_ERROR_CODES[err?.code];
  if (code) return new RconError(code, err.message, { cause: err });
  return new RconError('CLOSED', err?.message ?? 'Connection closed', { cause: err });
}

function encodePacket(id, type, body = '') {
  const bytes = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + bytes.length);
  out.writeInt32LE(10 + bytes.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  bytes.copy(out, 12);
  return out;
}

// One RCON connection. Commands are NOT queued: call exec() again only after
// the previous call settled (a concurrent call rejects with a plain Error).
// 'close' is emitted once for every connection that finished authenticating
// and then ended (close(), peer disconnect, socket error, command TIMEOUT).
// A connect() that fails never emits 'close'; its promise rejects instead.
export class RconClient extends EventEmitter {
  #host;
  #port;
  #password;
  #timeoutMs;
  #keepAlive;
  #conn = null; // current connection, authenticated or not
  #connecting = null; // promise of the connect() in progress
  #pending = null; // the single in-flight exec
  #nextId = 1;

  // keepAlive: enable TCP keepalive so a silently dead peer is noticed.
  constructor({ host, port, password, timeoutMs = 5000, keepAlive = false }) {
    super();
    this.#host = host;
    this.#port = port;
    this.#password = password;
    this.#timeoutMs = timeoutMs;
    this.#keepAlive = keepAlive;
  }

  // Request ids are positive int32, incrementing; a command uses id and id + 1.
  #allocId() {
    if (this.#nextId > MAX_REQUEST_ID) this.#nextId = 1;
    const id = this.#nextId;
    this.#nextId += 2;
    return id;
  }

  // Connects and authenticates; `timeoutMs` covers both steps.
  connect() {
    if (this.#conn?.ready) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    const attempt = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.#host, port: this.#port });
      socket.setNoDelay(true);
      if (this.#keepAlive) socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      const conn = {
        socket,
        buf: Buffer.alloc(0),
        ready: false,
        done: false,
        authId: this.#allocId(),
        timer: null,
        rejectConnect: reject,
        rawError: null,
        error: null,
      };
      this.#conn = conn;
      conn.timer = setTimeout(
        () => this.#teardown(conn, new RconError('TIMEOUT', 'Connection timed out')),
        this.#timeoutMs,
      );
      socket.on('connect', () => {
        socket.write(encodePacket(conn.authId, TYPE_AUTH, this.#password));
      });
      socket.on('data', (chunk) => this.#onData(conn, chunk, resolve));
      socket.on('error', (err) => {
        conn.rawError = err;
        conn.error = fromSocketError(err);
        this.#teardown(conn);
      });
      socket.on('close', () => this.#teardown(conn));
    });
    const tracked = attempt.finally(() => {
      // A newer connect() may already own the slot (teardown clears it early).
      if (this.#connecting === tracked) this.#connecting = null;
    });
    this.#connecting = tracked;
    return tracked;
  }

  // Runs one command and resolves with the complete response text. After the
  // command (type 2, id N) an empty type-0 sentinel (id N + 1) is sent; the
  // server answers in order, so every body with id N seen before id N + 1
  // belongs to the response. Bodies are kept as bytes and decoded once at the
  // end, so a multi-byte character split between packets stays intact.
  async exec(cmd) {
    const conn = this.#conn;
    if (!conn?.ready) throw new RconError('CLOSED', 'Not connected');
    if (this.#pending) throw new Error('Concurrent exec on one RconClient is not supported');
    return new Promise((resolve, reject) => {
      const id = this.#allocId();
      const pending = { conn, id, sentinel: id + 1, chunks: [], resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        // The stream state is unknown now: drop the connection so the next
        // caller reconnects cleanly.
        this.#pending = null;
        reject(new RconError('TIMEOUT', 'Command timed out'));
        this.#teardown(conn);
      }, this.#timeoutMs);
      this.#pending = pending;
      conn.socket.write(
        Buffer.concat([encodePacket(id, TYPE_EXEC, cmd), encodePacket(id + 1, TYPE_RESPONSE_VALUE)]),
      );
    });
  }

  close() {
    if (this.#conn) this.#teardown(this.#conn);
  }

  #onData(conn, chunk, resolveConnect) {
    if (conn.done) return;
    conn.buf = Buffer.concat([conn.buf, chunk]);
    while (!conn.done && conn.buf.length >= 4) {
      const length = conn.buf.readInt32LE(0);
      if (length < 10 || length > MAX_PACKET_LENGTH) {
        conn.error = new RconError('CLOSED', `Invalid packet length ${length}`);
        this.#teardown(conn);
        return;
      }
      if (conn.buf.length < 4 + length) return;
      const id = conn.buf.readInt32LE(4);
      const type = conn.buf.readInt32LE(8);
      const body = conn.buf.subarray(12, 4 + length - 2);
      conn.buf = conn.buf.subarray(4 + length);
      this.#onPacket(conn, id, type, body, resolveConnect);
    }
  }

  #onPacket(conn, id, type, body, resolveConnect) {
    if (!conn.ready) {
      // Some servers send an empty type-0 packet before the auth response.
      if (type !== TYPE_EXEC) return;
      if (id === AUTH_FAILED_ID) {
        this.#teardown(conn, new RconError('AUTH_FAILED', 'Authentication failed'));
      } else if (id === conn.authId) {
        clearTimeout(conn.timer);
        conn.ready = true;
        conn.rejectConnect = null;
        resolveConnect();
      }
      return;
    }
    const pending = this.#pending;
    if (!pending || pending.conn !== conn) return;
    if (id === pending.sentinel) {
      clearTimeout(pending.timer);
      this.#pending = null;
      pending.resolve(Buffer.concat(pending.chunks).toString('utf8'));
    } else if (id === pending.id && type === TYPE_RESPONSE_VALUE) {
      // Copy: the read buffer is re-sliced and must not be retained.
      pending.chunks.push(Buffer.from(body));
    }
  }

  // Idempotent end of a connection: fails whatever waits on it and emits 'close'.
  #teardown(conn, connectError) {
    if (conn.done) return;
    conn.done = true;
    clearTimeout(conn.timer);
    const wasReady = conn.ready;
    conn.ready = false;
    if (this.#conn === conn) {
      this.#conn = null;
      this.#connecting = null; // so close() then connect() starts a fresh attempt
    }
    conn.socket.destroy();
    conn.rejectConnect?.(connectError ?? conn.error ?? new RconError('CLOSED', 'Connection closed'));
    conn.rejectConnect = null;
    const pending = this.#pending;
    if (pending && pending.conn === conn) {
      clearTimeout(pending.timer);
      this.#pending = null;
      pending.reject(
        new RconError('CLOSED', conn.rawError?.message ?? 'Connection closed', {
          cause: conn.rawError ?? undefined,
        }),
      );
    }
    if (wasReady) this.emit('close');
  }
}
