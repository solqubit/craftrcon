export function createSettings(db) {
  const selectOne = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  function get(key, fallback) {
    const row = selectOne.get(key);
    return row ? row.value : fallback;
  }

  function set(key, value) {
    upsert.run(key, String(value));
  }

  function getJson(key, fallback) {
    const row = selectOne.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  function setJson(key, value) {
    upsert.run(key, JSON.stringify(value));
  }

  return { get, set, getJson, setJson };
}
