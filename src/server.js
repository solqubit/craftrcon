import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { openDb } from './db/index.js';
import { loadOrCreateKey } from './security/secretbox.js';
import { createSessions } from './security/sessions.js';
import { createSettings } from './services/settings.js';
import { createAudit } from './services/audit.js';
import { createServers } from './services/servers.js';
import { ConnectionManager } from './minecraft/connection.js';

const config = loadConfig();
const dataDir = resolve(config.dataDir);
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, 'craftrcon.db'));
const key = loadOrCreateKey(join(dataDir, 'secret.key'));
const servers = createServers(db, key);
const manager = new ConnectionManager((id) => servers.credentials(id));

const app = buildApp({
  config,
  db,
  services: {
    settings: createSettings(db),
    sessions: createSessions(db),
    audit: createAudit(db),
    servers,
    manager,
  },
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  manager.closeAll();
  try {
    await app.close();
    db.close();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  console.error(err);
  process.exit(1);
}
