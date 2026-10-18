import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { hashPassword } from '../src/security/password.js';
import { createSettings } from '../src/services/settings.js';
import { createSessions } from '../src/security/sessions.js';
import { createAudit } from '../src/services/audit.js';
import { createServers } from '../src/services/servers.js';
import { createHub } from '../src/services/hub.js';
import { createCommands } from '../src/services/commands.js';
import { ConnectionManager } from '../src/minecraft/connection.js';

export const TEST_HOST = 'panel.test';
export const TEST_ORIGIN = `http://${TEST_HOST}`;

// Builds a real app on an in-memory database with real services (including
// servers with a throwaway encryption key, and a connection manager). `login()`
// returns headers (cookie + same-origin Origin/Host) for authenticated calls.
// Pass `password: null` to leave the admin password unset.
export async function makeApp({ password = 'correct-horse-battery', config = {}, services: extra = {} } = {}) {
  const db = openDb(':memory:');
  const settings = createSettings(db);
  if (password) settings.set('admin_password_hash', await hashPassword(password));
  const servers = createServers(db, randomBytes(32));
  const audit = createAudit(db);
  const manager = new ConnectionManager((id) => servers.credentials(id));
  const hub = createHub();
  const services = {
    settings,
    sessions: createSessions(db),
    audit,
    servers,
    manager,
    hub,
    commands: createCommands({ db, manager, audit, hub }),
    ...extra,
  };
  const app = buildApp({ config: { ...loadConfig({}), ...config }, db, services });

  async function login() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: TEST_HOST, origin: TEST_ORIGIN },
      payload: { password },
    });
    if (res.statusCode !== 204) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const sid = res.cookies.find((c) => c.name === 'craftrcon_sid');
    return { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `craftrcon_sid=${sid.value}` };
  }

  return { app, db, services, login };
}
