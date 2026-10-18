import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_IDLE_MS = 7 * 24 * 3600e3;
// last_seen is written at most this often per session. Each write is also when
// the auth hook renews the cookie, so the cookie and the server-side idle limit
// expire together (up to one renewal interval earlier than the last request).
const DEFAULT_RENEW_MS = 3600e3;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Server-side sessions. Only the SHA-256 of the token is stored, so a leaked
// database cannot be replayed as cookies. Idle expiry is judged by last_seen.
export function createSessions(
  db,
  { idleMs = DEFAULT_IDLE_MS, renewMs = DEFAULT_RENEW_MS, now = Date.now } = {},
) {
  const insert = db.prepare('INSERT INTO sessions (id_hash, created_at, last_seen) VALUES (?, ?, ?)');
  const select = db.prepare('SELECT last_seen FROM sessions WHERE id_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE id_hash = ?');
  const removeAll = db.prepare('DELETE FROM sessions');
  const removeOthers = db.prepare('DELETE FROM sessions WHERE id_hash != ?');
  const removeIdle = db.prepare('DELETE FROM sessions WHERE last_seen < ?');

  function create() {
    const token = randomBytes(32).toString('base64url');
    const ts = now();
    insert.run(hashToken(token), ts, ts);
    return token;
  }

  // null for a missing or idle session (an idle one is removed); otherwise
  // { renewed }, true when last_seen was just moved forward (at most once per
  // renewMs), which is when the caller should re-send the cookie.
  function check(token) {
    if (typeof token !== 'string' || token === '') return null;
    const idHash = hashToken(token);
    const row = select.get(idHash);
    if (!row) return null;
    const ts = now();
    if (ts - row.last_seen > idleMs) {
      remove.run(idHash);
      return null;
    }
    if (ts - row.last_seen < renewMs) return { renewed: false };
    touch.run(ts, idHash);
    return { renewed: true };
  }

  const validate = (token) => check(token) !== null;

  function destroy(token) {
    if (typeof token !== 'string' || token === '') return;
    remove.run(hashToken(token));
  }

  function destroyAll() {
    removeAll.run();
  }

  // Signs out every client except the one holding `token` (password change).
  function destroyAllExcept(token) {
    if (typeof token !== 'string' || token === '') {
      removeAll.run();
      return;
    }
    removeOthers.run(hashToken(token));
  }

  // Drops sessions idle past the idle limit, so abandoned ones don't pile up.
  function purgeIdle() {
    return Number(removeIdle.run(now() - idleMs).changes);
  }

  // Opaque identifier of a session that is safe to keep in memory (the live hub
  // tags its sockets with it) because it is not the cookie token itself.
  const keyOf = (token) => (typeof token === 'string' && token !== '' ? hashToken(token) : null);

  return { create, check, validate, destroy, destroyAll, destroyAllExcept, purgeIdle, keyOf };
}
