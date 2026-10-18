import { serverListPing } from '../minecraft/ping.js';
import { parseTps } from '../minecraft/parsers.js';

export const STATUS_TTL_MS = 5000;

const OFFLINE = {
  version: null,
  software: null,
  players: null,
  motd: null,
  latencyMs: null,
  tps: null,
  tpsSupported: false,
};

// Live status of each server: a Server List Ping (SLP), plus the TPS over RCON
// when the server answers the ping. Results are cached per server for `ttlMs`
// and concurrent callers share one in-flight probe.
export function createStatus({ servers, commands, ping = serverListPing, now = Date.now, ttlMs = STATUS_TTL_MS }) {
  const cache = new Map(); // serverId -> { at, value }
  const inflight = new Map(); // serverId -> Promise<Status>
  const unsupported = new Set(); // servers that answered `tps` with something unparseable
  const epoch = new Map(); // serverId -> number; bumped by forget() to discard stale probes

  const epochOf = (id) => epoch.get(id) ?? 0;

  // Returns [tps, tpsSupported]. A failed RCON call is not proof the command is
  // unsupported (the server may be mid-restart), so it is reported but not remembered.
  async function readTps(id) {
    if (unsupported.has(id)) return [null, false];
    let result;
    try {
      result = await commands.run(id, 'tps', { origin: 'ui', audit: false, publish: false });
    } catch {
      return [null, false];
    }
    if (!result.ok) return [null, false];
    const tps = parseTps(result.output);
    if (tps === null) {
      unsupported.add(id);
      return [null, false];
    }
    return [tps, true];
  }

  async function probe(server) {
    const result = await ping({ host: server.host, port: server.gamePort });
    if (!result.online) return { online: false, error: result.error, ...OFFLINE };
    const [tps, tpsSupported] = await readTps(server.id);
    return {
      online: true,
      version: result.version,
      software: result.software,
      players: { online: result.players.online, max: result.players.max },
      motd: result.motd,
      latencyMs: result.latencyMs,
      tps,
      tpsSupported,
    };
  }

  // Drops everything remembered about a server (call when it is edited or deleted).
  function forget(serverId) {
    cache.delete(serverId);
    inflight.delete(serverId);
    unsupported.delete(serverId);
    epoch.set(serverId, epochOf(serverId) + 1);
  }

  // Rejects with an Error whose code is NOT_FOUND for an unknown server.
  function get(serverId) {
    const server = servers.get(serverId);
    if (!server) {
      forget(serverId);
      return Promise.reject(Object.assign(new Error(`Server ${serverId} not found`), { code: 'NOT_FOUND' }));
    }
    const cached = cache.get(serverId);
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    const pending = inflight.get(serverId);
    if (pending) return pending;

    const startedAt = epochOf(serverId);
    const promise = probe(server)
      .then((value) => {
        if (epochOf(serverId) === startedAt) cache.set(serverId, { at: now(), value });
        return value;
      })
      .finally(() => {
        if (inflight.get(serverId) === promise) inflight.delete(serverId);
      });
    inflight.set(serverId, promise);
    return promise;
  }

  return { get, forget };
}
