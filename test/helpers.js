import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { hashPassword } from '../src/security/password.js';
import { createSettings } from '../src/services/settings.js';
import { createSessions } from '../src/security/sessions.js';
import { createAudit } from '../src/services/audit.js';

export const TEST_HOST = 'panel.test';
export const TEST_ORIGIN = `http://${TEST_HOST}`;

// Builds a real app on an in-memory database with real services. `login()`
// returns headers (cookie + same-origin Origin/Host) for authenticated calls.
// Pass `password: null` to leave the admin password unset.
export async function makeApp({ password = 'correct-horse-battery', config = {}, services: extra = {} } = {}) {
  const db = openDb(':memory:');
  const settings = createSettings(db);
  if (password) settings.set('admin_password_hash', await hashPassword(password));
  const services = {
    settings,
    sessions: createSessions(db),
    audit: createAudit(db),
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
