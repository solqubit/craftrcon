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
import { createHub } from './services/hub.js';
import { createCommands } from './services/commands.js';
import { createStatus } from './services/status.js';
import { createSampler } from './services/sampler.js';
import { createHeads } from './services/heads.js';
import { createScheduler } from './services/scheduler.js';
import { createUpdateCheck } from './services/updateCheck.js';
import { createMaintenance } from './services/maintenance.js';
import { ConnectionManager } from './minecraft/connection.js';

const config = loadConfig();
const dataDir = resolve(config.dataDir);
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, 'craftrcon.db'));
const key = loadOrCreateKey(join(dataDir, 'secret.key'));
const servers = createServers(db, key);
const manager = new ConnectionManager((id) => servers.credentials(id));
const audit = createAudit(db);
const sessions = createSessions(db);
const hub = createHub();
const commands = createCommands({ db, manager, audit, hub });
const status = createStatus({ servers, commands });

const app = buildApp({
  config,
  db,
  services: {
    settings: createSettings(db),
    sessions,
    updateCheck: createUpdateCheck({ current: config.version }),
    audit,
    servers,
    manager,
    hub,
    commands,
    status,
    heads: createHeads({ dir: join(dataDir, 'heads') }),
  },
});
const sampler = createSampler({ db, servers, status, hub, log: app.log });
app.services.sampler = sampler;
const scheduler = createScheduler({ db, commands, audit, log: app.log });
app.services.scheduler = scheduler;
const maintenance = createMaintenance({ audit, sessions, log: app.log });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  sampler.stop();
  scheduler.stop();
  maintenance.stop();
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
sampler.start();
scheduler.start();
maintenance.start();
