import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TEST_HOST, TEST_ORIGIN } from './helpers.js';
import { compareSemver, createUpdateCheck } from '../src/services/updateCheck.js';
import { createMaintenance } from '../src/services/maintenance.js';
import { createHub } from '../src/services/hub.js';
import { createSessions } from '../src/security/sessions.js';
import { createAudit } from '../src/services/audit.js';
import { openDb } from '../src/db/index.js';
import { verifyPassword } from '../src/security/password.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../public/js/data/dangerous.js';

const DAY = 24 * 3600e3;

async function setup(t, options) {
  const ctx = await makeApp(options);
  t.after(async () => {
    ctx.services.manager.closeAll();
    for (const client of ctx.app.websocketServer.clients) client.terminate();
    await ctx.app.close();
  });
  const headers = await ctx.login();
  const call = (method, url, payload, h = headers) =>
    ctx.app.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload }) });
  return { ...ctx, headers, call };
}

const textResponse = (text, ok = true) => ({ ok, text: async () => text });

// ---- password ----------------------------------------------------------------

test('password change: wrong current is 403 and changes nothing', async (t) => {
  const { call, services } = await setup(t);
  const before = services.settings.get('admin_password_hash');
  const res = await call('POST', '/api/settings/password', { current: 'nope-nope-nope', next: 'a-new-password' });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: 'invalid_password' });
  assert.equal(services.settings.get('admin_password_hash'), before);
});

test('password change: missing or non-string fields are 400 validation', async (t) => {
  const { call } = await setup(t);
  for (const payload of [{}, { current: 'correct-horse-battery' }, { next: 'a-new-password' }, { current: 1, next: 2 }]) {
    const res = await call('POST', '/api/settings/password', payload);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'validation');
  }
});

test('password change: next shorter than 8 characters is 400 password_too_short', async (t) => {
  const { call, services } = await setup(t);
  const before = services.settings.get('admin_password_hash');
  const res = await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'short77' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'password_too_short' });
  assert.equal(services.settings.get('admin_password_hash'), before);
  // Exactly 8 characters is accepted.
  const ok = await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'exactly8' });
  assert.equal(ok.statusCode, 204);
});

test('password change: 204, new hash stored, other sessions end, current stays, audited', async (t) => {
  const { app, call, login, services } = await setup(t);
  const other = await login();
  assert.equal((await call('GET', '/api/me', undefined, other)).statusCode, 200);

  const res = await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'a-new-password' });
  assert.equal(res.statusCode, 204);

  assert.equal((await call('GET', '/api/me', undefined, other)).statusCode, 401, 'other client signed out');
  assert.equal((await call('GET', '/api/me')).statusCode, 200, 'caller stays signed in');
  assert.equal(await verifyPassword('a-new-password', services.settings.get('admin_password_hash')), true);
  assert.equal(await verifyPassword('correct-horse-battery', services.settings.get('admin_password_hash')), false);

  const row = services.audit.list({}).find((r) => r.action === 'password_change');
  assert.equal(row.origin, 'auth');
  assert.equal(row.ok, true);

  // The new password logs in; the old one no longer does.
  const login2 = (password) =>
    app.inject({ method: 'POST', url: '/api/login', headers: { host: TEST_HOST, origin: TEST_ORIGIN }, payload: { password } });
  assert.equal((await login2('a-new-password')).statusCode, 204);
  assert.equal((await login2('correct-horse-battery')).statusCode, 401);
});

test('settings routes need a session', async (t) => {
  const { app } = await setup(t);
  const headers = { host: TEST_HOST, origin: TEST_ORIGIN };
  for (const [method, url] of [
    ['POST', '/api/settings/password'],
    ['GET', '/api/settings/dangerous-commands'],
    ['PUT', '/api/settings/dangerous-commands'],
    ['GET', '/api/activity'],
    ['GET', '/api/version'],
  ]) {
    assert.equal((await app.inject({ method, url, headers, payload: method === 'GET' ? undefined : {} })).statusCode, 401, url);
  }
});

test('sessions.destroyAllExcept keeps only the given token', () => {
  const sessions = createSessions(openDb(':memory:'));
  const a = sessions.create();
  const b = sessions.create();
  sessions.destroyAllExcept(a);
  assert.equal(sessions.validate(a), true);
  assert.equal(sessions.validate(b), false);
});

// ---- dangerous commands -------------------------------------------------------

test('dangerous commands: default, then update and read back', async (t) => {
  const { call } = await setup(t);
  const initial = await call('GET', '/api/settings/dangerous-commands');
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), ['stop', 'op', 'deop', 'ban-ip', 'kill @e', 'whitelist off', 'difficulty']);
  assert.deepEqual(initial.json(), [...DEFAULT_DANGEROUS_COMMANDS]);

  const put = await call('PUT', '/api/settings/dangerous-commands', ['stop', 'fill']);
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), ['stop', 'fill']);
  assert.deepEqual((await call('GET', '/api/settings/dangerous-commands')).json(), ['stop', 'fill']);

  // An empty list is allowed (no confirmations), and PUTting the defaults restores them.
  assert.deepEqual((await call('PUT', '/api/settings/dangerous-commands', [])).json(), []);
  assert.deepEqual((await call('GET', '/api/settings/dangerous-commands')).json(), []);
  await call('PUT', '/api/settings/dangerous-commands', [...DEFAULT_DANGEROUS_COMMANDS]);
  assert.deepEqual((await call('GET', '/api/settings/dangerous-commands')).json(), [...DEFAULT_DANGEROUS_COMMANDS]);
});

test('dangerous commands: trims and dedupes case-insensitively, keeping the first spelling', async (t) => {
  const { call } = await setup(t);
  const res = await call('PUT', '/api/settings/dangerous-commands', ['  Stop ', 'stop', 'STOP', 'kill @e', 'KILL @E']);
  assert.deepEqual(res.json(), ['Stop', 'kill @e']);
});

test('dangerous commands: invalid bodies are 400 validation and store nothing', async (t) => {
  const ctx = await setup(t);
  const { call } = ctx;
  const bad = [
    { reset: true },
    'stop',
    null,
    [1],
    [''],
    ['   '],
    ['two\nlines'],
    ['a\rb'],
    ['x'.repeat(65)],
    Array.from({ length: 51 }, (_, i) => `cmd${i}`),
  ];
  for (const payload of bad) {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/dangerous-commands',
      headers: { ...ctx.headers, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 40));
    assert.equal(res.json().error, 'validation');
  }
  assert.deepEqual((await call('GET', '/api/settings/dangerous-commands')).json(), [...DEFAULT_DANGEROUS_COMMANDS]);

  // Boundaries that are accepted: 64 characters, 50 entries.
  assert.equal((await call('PUT', '/api/settings/dangerous-commands', ['x'.repeat(64)])).statusCode, 200);
  const fifty = Array.from({ length: 50 }, (_, i) => `cmd${i}`);
  assert.equal((await call('PUT', '/api/settings/dangerous-commands', fifty)).statusCode, 200);
});

// ---- activity -----------------------------------------------------------------

async function seedActivity(call, services) {
  const a = (await call('POST', '/api/servers', { name: 'Alpha', host: '127.0.0.1', rconPort: 1, password: 'pw' })).json().id;
  const b = (await call('POST', '/api/servers', { name: 'Beta', host: '127.0.0.1', rconPort: 2, password: 'pw' })).json().id;
  for (let i = 1; i <= 3; i += 1) services.audit.log({ serverId: a, origin: 'console', action: `a${i}`, detail: `d${i}`, result: 'r' });
  services.audit.log({ serverId: b, origin: 'ui', action: 'b1', ok: false });
  services.audit.log({ origin: 'system', action: 'sys' });
  return { a, b };
}

test('activity: lists newest first with server names and camelCase fields', async (t) => {
  const { call, services } = await setup(t);
  const { a } = await seedActivity(call, services);
  const body = (await call('GET', '/api/activity')).json();
  assert.equal(body.nextBefore, null);
  assert.deepEqual(
    body.items.slice(0, 5).map((r) => r.action),
    ['sys', 'b1', 'a3', 'a2', 'a1'],
  );
  const sys = body.items[0];
  assert.deepEqual(Object.keys(sys).sort(), ['action', 'detail', 'id', 'ok', 'origin', 'result', 'serverId', 'serverName', 'ts']);
  assert.equal(sys.serverId, null);
  assert.equal(sys.serverName, null);
  const a3 = body.items.find((r) => r.action === 'a3');
  assert.equal(a3.serverId, a);
  assert.equal(a3.serverName, 'Alpha');
  assert.equal(a3.detail, 'd3');
  assert.equal(a3.result, 'r');
  assert.equal(a3.ok, true);
  assert.equal(body.items.find((r) => r.action === 'b1').ok, false);
});

test('activity: serverId filters by server', async (t) => {
  const { call, services } = await setup(t);
  const { a, b } = await seedActivity(call, services);
  const onlyA = (await call('GET', `/api/activity?serverId=${a}`)).json();
  assert.deepEqual(onlyA.items.map((r) => r.action), ['a3', 'a2', 'a1', 'server_create']);
  assert.ok(onlyA.items.every((r) => r.serverId === a && r.serverName === 'Alpha'));
  const onlyB = (await call('GET', `/api/activity?serverId=${b}`)).json();
  assert.deepEqual(onlyB.items.map((r) => r.action), ['b1', 'server_create']);
  assert.deepEqual((await call('GET', '/api/activity?serverId=9999')).json(), { items: [], nextBefore: null });
});

test('activity: pages with limit and the before cursor', async (t) => {
  const { call, services } = await setup(t);
  const { a } = await seedActivity(call, services);
  const first = (await call('GET', `/api/activity?serverId=${a}&limit=2`)).json();
  assert.deepEqual(first.items.map((r) => r.action), ['a3', 'a2']);
  assert.equal(first.nextBefore, first.items[1].id);
  const second = (await call('GET', `/api/activity?serverId=${a}&limit=2&before=${first.nextBefore}`)).json();
  assert.deepEqual(second.items.map((r) => r.action), ['a1', 'server_create']);
  assert.equal(second.nextBefore, null);
  // A page that ends exactly at the last row has no next page.
  const exact = (await call('GET', `/api/activity?serverId=${a}&limit=4`)).json();
  assert.equal(exact.items.length, 4);
  assert.equal(exact.nextBefore, null);
  // Empty params mean "not given".
  const empty = (await call('GET', '/api/activity?serverId=&before=&limit=')).json();
  assert.ok(empty.items.length >= 5);
});

test('activity: invalid params are 400', async (t) => {
  const { call } = await setup(t);
  for (const qs of ['limit=0', 'limit=201', 'limit=abc', 'limit=-1', 'limit=1.5', 'serverId=abc', 'serverId=0', 'before=x', 'before=-3']) {
    const res = await call('GET', `/api/activity?${qs}`);
    assert.equal(res.statusCode, 400, qs);
    assert.equal(res.json().error, 'validation');
  }
  assert.equal((await call('GET', '/api/activity?limit=200')).statusCode, 200);
  assert.equal((await call('GET', '/api/activity?limit=1&limit=2')).statusCode, 400);
});

// ---- update check -------------------------------------------------------------

test('compareSemver orders versions numerically', () => {
  assert.equal(compareSemver('0.10.0', '0.9.9'), 1);
  assert.equal(compareSemver('0.9.9', '0.10.0'), -1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemver('1.0.0+build5', '1.0.0'), 0);
  assert.throws(() => compareSemver('1.0', '1.0.0'), TypeError);
});

test('update check: newer, same and older latest', async () => {
  const run = async (latest) =>
    createUpdateCheck({ current: '0.1.0', fetchImpl: async () => textResponse(`${latest}\n`) }).check();
  assert.deepEqual(await run('0.2.0'), { installed: '0.1.0', latest: '0.2.0', updateAvailable: true });
  assert.deepEqual(await run('0.1.0'), { installed: '0.1.0', latest: '0.1.0', updateAvailable: false });
  assert.deepEqual(await run('0.0.9'), { installed: '0.1.0', latest: '0.0.9', updateAvailable: false });
});

test('update check: failures give latest null without throwing', async () => {
  const failures = [
    async () => {
      throw new Error('offline');
    },
    async () => textResponse('Not Found', false),
    async () => textResponse('<html>captive portal</html>'),
    async () => textResponse('x'.repeat(5000)),
    async () => ({ ok: true, text: async () => { throw new Error('reset'); } }),
  ];
  for (const fetchImpl of failures) {
    const result = await createUpdateCheck({ current: '0.1.0', fetchImpl }).check();
    assert.deepEqual(result, { installed: '0.1.0', latest: null, updateAvailable: false });
  }
});

test('update check: asks with a timeout signal and refuses redirects', async () => {
  let seen;
  const check = createUpdateCheck({
    current: '0.1.0',
    url: 'https://example.test/VERSION',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return textResponse('0.1.0');
    },
  });
  await check.check();
  assert.equal(seen.url, 'https://example.test/VERSION');
  assert.equal(seen.init.redirect, 'error');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('update check: success is cached 6 h, failure only 10 min, concurrent calls share one fetch', async () => {
  let clock = 1_000_000;
  let calls = 0;
  let answer = () => textResponse('0.2.0');
  const check = createUpdateCheck({
    current: '0.1.0',
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return answer();
    },
  });
  await Promise.all([check.check(), check.check(), check.check()]);
  assert.equal(calls, 1);
  clock += 5 * 3600e3;
  await check.check();
  assert.equal(calls, 1, 'still cached after 5 h');
  clock += 2 * 3600e3;
  await check.check();
  assert.equal(calls, 2, 'refetched after 6 h');

  answer = () => {
    throw new Error('offline');
  };
  clock += 7 * 3600e3;
  assert.equal((await check.check()).latest, null);
  assert.equal(calls, 3);
  clock += 5 * 60e3;
  await check.check();
  assert.equal(calls, 3, 'failure cached for 5 min');
  answer = () => textResponse('0.3.0');
  clock += 6 * 60e3;
  assert.equal((await check.check()).latest, '0.3.0');
  assert.equal(calls, 4, 'failure retried after 10 min');
});

test('GET /api/version reports installed and latest through the injected fetch', async (t) => {
  const offline = await setup(t);
  const config = await offline.call('GET', '/api/health');
  assert.equal(config.statusCode, 200);
  assert.deepEqual((await offline.call('GET', '/api/version')).json(), {
    installed: config.json().version,
    latest: null,
    updateAvailable: false,
  });

  const online = await setup(t, { versionFetch: async () => textResponse('99.0.0') });
  const body = (await online.call('GET', '/api/version')).json();
  assert.equal(body.latest, '99.0.0');
  assert.equal(body.updateAvailable, true);
});

// ---- daily purge --------------------------------------------------------------

test('sessions.purgeIdle drops only sessions idle past the limit', () => {
  const db = openDb(':memory:');
  const sessions = createSessions(db);
  const fresh = sessions.create();
  sessions.create();
  const staleRow = db.prepare('SELECT id_hash FROM sessions ORDER BY created_at, rowid').all()[1];
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(Date.now() - 8 * DAY, staleRow.id_hash);
  assert.equal(sessions.purgeIdle(), 1);
  assert.equal(sessions.validate(fresh), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('maintenance purges audit older than 90 days and idle sessions', () => {
  const db = openDb(':memory:');
  let clock = Date.now();
  const audit = createAudit(db, { now: () => clock });
  const sessions = createSessions(db, { now: () => clock });
  const maintenance = createMaintenance({ audit, sessions });

  audit.log({ origin: 'system', action: 'ancient' });
  clock += 91 * DAY;
  audit.log({ origin: 'system', action: 'recent' });
  const old = sessions.create();
  clock += 8 * DAY;
  const young = sessions.create();

  assert.deepEqual(maintenance.run(), { audit: 1, sessions: 1 });
  assert.deepEqual(audit.list({}).map((r) => r.action), ['recent']);
  assert.equal(sessions.validate(old), false);
  assert.equal(sessions.validate(young), true);
});

test('maintenance runs once shortly after start, then daily', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let runs = 0;
  const maintenance = createMaintenance({
    audit: { purge: () => ++runs },
    sessions: { purgeIdle: () => 0 },
  });
  maintenance.start();
  maintenance.start(); // idempotent
  t.mock.timers.tick(59_000);
  assert.equal(runs, 0);
  t.mock.timers.tick(1_000);
  assert.equal(runs, 1, 'first run after ~1 min');
  t.mock.timers.tick(DAY);
  assert.equal(runs, 2, 'then every 24 h');
  maintenance.stop();
  t.mock.timers.tick(2 * DAY);
  assert.equal(runs, 2, 'stopped');
});

test('maintenance logs instead of throwing when a purge fails', () => {
  const logged = [];
  const maintenance = createMaintenance({
    audit: {
      purge: () => {
        throw new Error('disk');
      },
    },
    sessions: { purgeIdle: () => 0 },
    log: { error: (...args) => logged.push(args) },
  });
  // The failing audit purge does not skip the sessions purge.
  assert.deepEqual(maintenance.run(), { audit: null, sessions: 0 });
  assert.equal(logged.length, 1);

  const flipped = createMaintenance({
    audit: { purge: () => 3 },
    sessions: {
      purgeIdle: () => {
        throw new Error('disk');
      },
    },
    log: { error: (...args) => logged.push(args) },
  });
  assert.deepEqual(flipped.run(), { audit: 3, sessions: null });
  assert.equal(logged.length, 2);
});

// ---- brute-force limiter on the password change -------------------------------

test('password change: 5 wrong currents lock the 6th attempt, even a correct one, with 429', async (t) => {
  const { call, services } = await setup(t);
  for (let i = 0; i < 5; i += 1) {
    const res = await call('POST', '/api/settings/password', { current: `wrong-guess-${i}`, next: 'a-new-password' });
    assert.equal(res.statusCode, 403);
  }
  const locked = await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'a-new-password' });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error, 'too_many_attempts');
  assert.ok(locked.json().retryAfterMs > 0);
  // Nothing changed.
  assert.equal(await verifyPassword('correct-horse-battery', services.settings.get('admin_password_hash')), true);
  // Every failed attempt was audited.
  const failed = services.audit.list({}).filter((r) => r.action === 'password_change' && r.ok === false);
  assert.equal(failed.length, 5);
  assert.ok(failed.every((r) => r.origin === 'auth'));
});

test('password change: failed password changes count against login', async (t) => {
  const { app, call, services } = await setup(t);
  const loginWith = (password) =>
    app.inject({ method: 'POST', url: '/api/login', headers: { host: TEST_HOST, origin: TEST_ORIGIN }, payload: { password } });

  // Wrong password-change guesses block login.
  for (let i = 0; i < 5; i += 1) {
    await call('POST', '/api/settings/password', { current: `wrong-guess-${i}`, next: 'a-new-password' });
  }
  assert.equal((await loginWith('correct-horse-battery')).statusCode, 429);
});

test('password change: failed logins count against the password-change budget', async (t) => {
  const { app, call } = await setup(t);
  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: TEST_HOST, origin: TEST_ORIGIN },
      payload: { password: `wrong-guess-${i}` },
    });
    assert.equal(res.statusCode, 401);
  }
  const res = await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'a-new-password' });
  assert.equal(res.statusCode, 429);
});

test('password change: a correct current resets the failure count; validation errors do not consume attempts', async (t) => {
  const { call } = await setup(t);
  for (let i = 0; i < 4; i += 1) {
    await call('POST', '/api/settings/password', { current: `wrong-guess-${i}`, next: 'a-new-password' });
  }
  for (let i = 0; i < 10; i += 1) await call('POST', '/api/settings/password', { current: 'x' });
  // Correct current (too-short next) still goes through and settles as success.
  assert.equal((await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'short' })).statusCode, 400);
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await call('POST', '/api/settings/password', { current: `wrong-again-${i}`, next: 'a-new-password' })).statusCode, 403);
  }
  assert.equal((await call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'a-new-password' })).statusCode, 204);
});

// ---- revoked sessions lose their live sockets ----------------------------------

async function openLive(t, ctx, headers, serverId) {
  const ws = await ctx.app.injectWS(`/api/servers/${serverId}/live`, { headers });
  t.after(() => ws.terminate());
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return { ws, closed };
}

const stillOpen = (promise) => Promise.race([promise.then(() => false), new Promise((r) => setTimeout(() => r(true), 150))]);

test('password change closes the live sockets of other sessions (4401) but not the caller\'s', async (t) => {
  const ctx = await setup(t);
  const serverId = (await ctx.call('POST', '/api/servers', { name: 'S', host: '127.0.0.1', rconPort: 1, password: 'pw' })).json().id;
  const other = await ctx.login(); // session A
  const mine = ctx.headers; // session B, the one changing the password
  const a = await openLive(t, ctx, other, serverId);
  const b = await openLive(t, ctx, mine, serverId);

  const res = await ctx.call('POST', '/api/settings/password', { current: 'correct-horse-battery', next: 'a-new-password' });
  assert.equal(res.statusCode, 204);

  assert.equal(await a.closed, 4401);
  assert.equal(await stillOpen(b.closed), true, 'caller socket stays open');
  assert.deepEqual(ctx.services.hub.subscribedServerIds(), [serverId], 'only the caller socket remains subscribed');
});

test('logout closes the caller\'s live sockets and leaves other sessions\' alone', async (t) => {
  const ctx = await setup(t);
  const serverId = (await ctx.call('POST', '/api/servers', { name: 'S', host: '127.0.0.1', rconPort: 1, password: 'pw' })).json().id;
  const other = await ctx.login();
  const mine = ctx.headers;
  const a = await openLive(t, ctx, other, serverId);
  const b = await openLive(t, ctx, mine, serverId);

  assert.equal((await ctx.call('POST', '/api/logout')).statusCode, 204);

  assert.equal(await b.closed, 4401);
  assert.equal(await stillOpen(a.closed), true, 'other session socket stays open');
});

test('hub.closeSessions closes matching sockets with 4401 and unsubscribes them', () => {
  const closes = [];
  const fake = (name) => ({ name, readyState: 1, close: (code, reason) => closes.push([name, code, reason]) });
  const hub = createHub();
  const [x, y, z] = [fake('x'), fake('y'), fake('z')];
  hub.subscribe(1, x, 'k1');
  hub.subscribe(1, y, 'k2');
  hub.subscribe(2, z); // no session key
  hub.closeSessions((key) => key !== 'k1');
  assert.deepEqual(closes, [['y', 4401, 'session_ended'], ['z', 4401, 'session_ended']]);
  assert.deepEqual(hub.subscribedServerIds(), [1]);
});
