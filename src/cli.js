import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { hashPassword } from './security/password.js';
import { loadOrCreateKey } from './security/secretbox.js';
import { createSettings } from './services/settings.js';

const MIN_PASSWORD_LENGTH = 8;
const USAGE = 'Usage: node src/cli.js <init|set-password>\n';

function prepareDataDir(config) {
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

async function readFirstLine(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function init() {
  const dataDir = prepareDataDir(loadConfig());
  openDb(join(dataDir, 'craftrcon.db')).close();
  loadOrCreateKey(join(dataDir, 'secret.key'));
  return 0;
}

async function setPassword() {
  const password = await readFirstLine(process.stdin);
  if (password.length < MIN_PASSWORD_LENGTH) {
    process.stderr.write('password_too_short\n');
    return 2;
  }
  const hash = await hashPassword(password);
  const dataDir = prepareDataDir(loadConfig());
  const db = openDb(join(dataDir, 'craftrcon.db'));
  try {
    db.exec('BEGIN');
    try {
      createSettings(db).set('admin_password_hash', hash);
      db.exec('DELETE FROM sessions');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }
  return 0;
}

async function main(command) {
  switch (command) {
    case 'init':
      return init();
    case 'set-password':
      return setPassword();
    default:
      process.stderr.write(USAGE);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
