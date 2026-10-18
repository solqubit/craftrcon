import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_IDLE_MS = 7 * 24 * 3600e3;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Server-side sessions. Only the SHA-256 of the token is stored, so a leaked
// database cannot be replayed as cookies. Idle expiry is judged by last_seen.
export function createSessions(db, { idleMs = DEFAULT_IDLE_MS, now = Date.now } = {}) {
  const insert = db.prepare('INSERT INTO sessions (id_hash, created_at, last_seen) VALUES (?, ?, ?)');
  const select = db.prepare('SELECT last_seen FROM sessions WHERE id_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE id_hash = ?');
  const removeAll = db.prepare('DELETE FROM sessions');

  function create() {
    const token = randomBytes(32).toString('base64url');
    const ts = now();
    insert.run(hashToken(token), ts, ts);
    return token;
  }

  function validate(token) {
    if (typeof token !== 'string' || token === '') return false;
    const idHash = hashToken(token);
    const row = select.get(idHash);
    if (!row) return false;
    const ts = now();
    if (ts - row.last_seen > idleMs) {
      remove.run(idHash);
      return false;
    }
    touch.run(ts, idHash);
    return true;
  }

  function destroy(token) {
    if (typeof token !== 'string' || token === '') return;
    remove.run(hashToken(token));
  }

  function destroyAll() {
    removeAll.run();
  }

  return { create, validate, destroy, destroyAll };
}
