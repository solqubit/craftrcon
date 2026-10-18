import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db/index.js';
import { verifyPassword } from '../src/security/password.js';
import { createSettings } from '../src/services/settings.js';

const CLI = resolve('src/cli.js');

function setup(dataDirValue) {
  const tmp = mkdtempSync(join(tmpdir(), 'craftrcon-cli-'));
  const dataDir = join(tmp, 'data');
  const configFile = join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ dataDir: dataDirValue ?? dataDir }));
  return { tmp, dataDir, configFile };
}

function run(configFile, args, { input, cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, CRAFTRCON_CONFIG: configFile },
    input,
    cwd,
    encoding: 'utf8',
  });
}

function withDb(dataDir, fn) {
  const db = openDb(join(dataDir, 'craftrcon.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('init creates dataDir, database and secret key', () => {
  const { tmp, dataDir, configFile } = setup();
  try {
    const res = run(configFile, ['init']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(dataDir, 'craftrcon.db')));
    assert.ok(existsSync(join(dataDir, 'secret.key')));
    withDb(dataDir, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    });
    // idempotent
    assert.equal(run(configFile, ['init']).status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('init resolves a relative dataDir against the current directory', () => {
  const { tmp, configFile } = setup('./rel-data');
  try {
    const res = run(configFile, ['init'], { cwd: tmp });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(tmp, 'rel-data', 'craftrcon.db')));
    assert.ok(existsSync(join(tmp, 'rel-data', 'secret.key')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('set-password stores a verifiable hash and never echoes the password', async () => {
  const { tmp, dataDir, configFile } = setup();
  try {
    assert.equal(run(configFile, ['init']).status, 0);
    const res = run(configFile, ['set-password'], { input: 'secret123\n' });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes('secret123'));
    assert.ok(!res.stderr.includes('secret123'));
    const hash = withDb(dataDir, (db) => createSettings(db).get('admin_password_hash'));
    assert.ok(hash);
    assert.equal(await verifyPassword('secret123', hash), true);
    assert.equal(await verifyPassword('secret124', hash), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('set-password strips CRLF line endings and ignores later lines', async () => {
  const { tmp, dataDir, configFile } = setup();
  try {
    assert.equal(run(configFile, ['init']).status, 0);
    const res = run(configFile, ['set-password'], { input: 'secret123\r\nignored\r\n' });
    assert.equal(res.status, 0, res.stderr);
    const hash = withDb(dataDir, (db) => createSettings(db).get('admin_password_hash'));
    assert.equal(await verifyPassword('secret123', hash), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('set-password accepts a password without trailing newline', async () => {
  const { tmp, dataDir, configFile } = setup();
  try {
    assert.equal(run(configFile, ['init']).status, 0);
    const res = run(configFile, ['set-password'], { input: 'secret123' });
    assert.equal(res.status, 0, res.stderr);
    const hash = withDb(dataDir, (db) => createSettings(db).get('admin_password_hash'));
    assert.equal(await verifyPassword('secret123', hash), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('set-password rejects short passwords with exit 2 and keeps the old hash', () => {
  const { tmp, dataDir, configFile } = setup();
  try {
    assert.equal(run(configFile, ['init']).status, 0);
    assert.equal(run(configFile, ['set-password'], { input: 'secret123\n' }).status, 0);
    const before = withDb(dataDir, (db) => createSettings(db).get('admin_password_hash'));

    for (const input of ['short\n', 'seven77\r\n', '', '\n']) {
      const res = run(configFile, ['set-password'], { input });
      assert.equal(res.status, 2, JSON.stringify(input));
      assert.match(res.stderr, /password_too_short/);
    }
    const after = withDb(dataDir, (db) => createSettings(db).get('admin_password_hash'));
    assert.equal(after, before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('set-password deletes existing sessions', () => {
  const { tmp, dataDir, configFile } = setup();
  try {
    assert.equal(run(configFile, ['init']).status, 0);
    withDb(dataDir, (db) => {
      const ins = db.prepare('INSERT INTO sessions (id_hash, created_at, last_seen) VALUES (?, ?, ?)');
      ins.run('a', 1, 1);
      ins.run('b', 1, 1);
    });
    const res = run(configFile, ['set-password'], { input: 'secret123\n' });
    assert.equal(res.status, 0, res.stderr);
    withDb(dataDir, (db) => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('unknown or missing subcommand prints usage on stderr and exits 1', () => {
  const { tmp, configFile } = setup();
  try {
    for (const args of [['bogus'], []]) {
      const res = run(configFile, args);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /usage/i);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSettings get/set/getJson/setJson', () => {
  const db = openDb(':memory:');
  try {
    const s = createSettings(db);
    assert.equal(s.get('missing'), undefined);
    assert.equal(s.get('missing', 'fb'), 'fb');
    s.set('k', 'v1');
    assert.equal(s.get('k'), 'v1');
    s.set('k', 'v2');
    assert.equal(s.get('k', 'fb'), 'v2');

    assert.deepEqual(s.getJson('j', { a: 1 }), { a: 1 });
    s.setJson('j', { a: [1, 2], b: 'ñ' });
    assert.deepEqual(s.getJson('j', null), { a: [1, 2], b: 'ñ' });
    s.set('bad', '{not json');
    assert.equal(s.getJson('bad', 'fb'), 'fb');
  } finally {
    db.close();
  }
});
