export const SAMPLE_INTERVAL_MS = 60_000;
export const SAMPLE_RETENTION_MS = 7 * 24 * 3600e3;
export const PUSH_INTERVAL_MS = 5000;

// Periodic work around server status: stores a player-count sample per online
// server and pushes the live status to the WebSocket clients watching a server.
export function createSampler({
  db,
  servers,
  status,
  hub,
  intervalMs = SAMPLE_INTERVAL_MS,
  retentionMs = SAMPLE_RETENTION_MS,
  pushIntervalMs = PUSH_INTERVAL_MS,
  now = Date.now,
  log = null,
}) {
  const insert = db.prepare('INSERT INTO player_samples (server_id, ts, online, max) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM player_samples WHERE ts < ?');
  const select = db.prepare(
    'SELECT ts, online, max FROM player_samples WHERE server_id = ? AND ts >= ? ORDER BY ts ASC',
  );
  let sampleTimer = null;
  let pushTimer = null;

  // One sample per online server, then drops the ones past the retention.
  async function tick() {
    await Promise.all(
      servers.list().map(async ({ id }) => {
        try {
          const current = await status.get(id);
          if (current.online) insert.run(id, now(), current.players.online, current.players.max);
        } catch (err) {
          // A server deleted mid-tick: skip it and keep sampling the rest.
          if (err?.code !== 'NOT_FOUND') log?.error({ err }, 'player sample failed');
        }
      }),
    );
    prune.run(now() - retentionMs);
  }

  // Samples of one server from the last `rangeMs`, oldest first.
  const samples = (serverId, rangeMs) => select.all(serverId, now() - rangeMs);

  // Publishes the status only for the servers somebody is watching.
  async function push() {
    await Promise.all(
      hub.subscribedServerIds().map(async (id) => {
        try {
          hub.publish(id, { type: 'status', status: await status.get(id) });
        } catch (err) {
          if (err?.code !== 'NOT_FOUND') log?.error({ err }, 'status push failed');
        }
      }),
    );
  }

  function start() {
    if (sampleTimer) return;
    sampleTimer = setInterval(() => tick().catch((err) => log?.error({ err }, 'sampler tick failed')), intervalMs);
    pushTimer = setInterval(() => push().catch((err) => log?.error({ err }, 'status push failed')), pushIntervalMs);
    sampleTimer.unref();
    pushTimer.unref();
  }

  function stop() {
    clearInterval(sampleTimer);
    clearInterval(pushTimer);
    sampleTimer = null;
    pushTimer = null;
  }

  return { tick, push, samples, start, stop };
}
