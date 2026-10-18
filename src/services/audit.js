export function createAudit(db, { now = Date.now } = {}) {
  const insert = db.prepare(
    'INSERT INTO audit (ts, server_id, origin, action, detail, ok, result) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const purgeStmt = db.prepare('DELETE FROM audit WHERE ts < ?');

  function log({ serverId = null, origin, action, detail = null, ok = true, result = null }) {
    insert.run(now(), serverId, origin, action, detail, ok ? 1 : 0, result);
  }

  // Newest first. `before` is a row id cursor: only rows with id < before.
  // `server_name` is null when the row has no server.
  function list({ serverId, limit = 100, before } = {}) {
    const where = [];
    const params = [];
    if (serverId !== undefined && serverId !== null) {
      where.push('a.server_id = ?');
      params.push(serverId);
    }
    if (before !== undefined && before !== null) {
      where.push('a.id < ?');
      params.push(before);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT a.id, a.ts, a.server_id, s.name AS server_name, a.origin, a.action, a.detail, a.ok, a.result
         FROM audit a LEFT JOIN servers s ON s.id = a.server_id ${clause} ORDER BY a.id DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map((r) => ({ ...r, ok: r.ok === 1 }));
  }

  function purge(olderThanMs) {
    return Number(purgeStmt.run(now() - olderThanMs).changes);
  }

  return { log, list, purge };
}
