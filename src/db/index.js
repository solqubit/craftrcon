import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .map((file) => {
      const m = /^(\d+)_.+\.sql$/.exec(file);
      return m ? { version: Number(m[1]), file } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');

  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (const { version, file: name } of loadMigrations()) {
    if (version <= current) continue;
    const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
