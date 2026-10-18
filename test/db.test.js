import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';

const TABLES = [
  'servers',
  'settings',
  'sessions',
  'favorites',
  'command_history',
  'tasks',
  'audit',
  'player_samples',
];

test('openDb(":memory:") applies migration 001 and creates all tables', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of TABLES) assert.ok(names.includes(t), `missing table ${t}`);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally {
    db.close();
  }
});

test('opening the same file twice is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'craftrcon-db-'));
  const file = join(dir, 'test.db');
  try {
    const first = openDb(file);
    assert.equal(first.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    first.prepare(
      "INSERT INTO servers (name, host, rcon_password_enc) VALUES ('a', 'h', 'x')",
    ).run();
    first.close();

    const second = openDb(file);
    assert.equal(second.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(second.prepare('SELECT COUNT(*) AS n FROM servers').get().n, 1);
    const tables = second
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='servers'")
      .get().n;
    assert.equal(tables, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a server cascades to all child tables', () => {
  const db = openDb(':memory:');
  try {
    const { lastInsertRowid: id } = db
      .prepare("INSERT INTO servers (name, host, rcon_password_enc) VALUES ('s', 'h', 'x')")
      .run();
    db.prepare("INSERT INTO favorites (server_id, label, command, position) VALUES (?, 'l', 'c', 0)").run(id);
    db.prepare("INSERT INTO command_history (server_id, command, ts) VALUES (?, 'list', 1)").run(id);
    db.prepare(
      "INSERT INTO tasks (server_id, name, enabled, trigger_type, interval_minutes, steps) VALUES (?, 't', 1, 'interval', 5, '[]')",
    ).run(id);
    db.prepare(
      "INSERT INTO audit (ts, server_id, origin, action, detail, ok, result) VALUES (1, ?, 'ui', 'a', 'd', 1, 'r')",
    ).run(id);
    db.prepare('INSERT INTO player_samples (server_id, ts, online, max) VALUES (?, 1, 2, 20)').run(id);

    db.prepare('DELETE FROM servers WHERE id = ?').run(id);

    for (const t of ['favorites', 'command_history', 'tasks', 'audit', 'player_samples']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} not cascaded`);
    }
  } finally {
    db.close();
  }
});
