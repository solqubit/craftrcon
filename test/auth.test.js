import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TEST_HOST, TEST_ORIGIN } from './helpers.js';
import { createRateLimiter } from '../src/security/rateLimit.js';

const SAME_ORIGIN = { host: TEST_HOST, origin: TEST_ORIGIN };
const GOOD = { password: 'correct-horse-battery' };

function post(app, url, payload, headers = SAME_ORIGIN) {
  return app.inject({ method: 'POST', url, headers, payload });
}

test('correct login sets an HttpOnly SameSite=Strict cookie', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const res = await post(app, '/api/login', GOOD);
  assert.equal(res.statusCode, 204);
  const raw = res.headers['set-cookie'];
  assert.match(raw, /^craftrcon_sid=[\w-]{43};/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Path=\//);
  assert.match(raw, /Max-Age=604800/);
  assert.doesNotMatch(raw, /Secure/);
});

test('cookie is Secure when a domain is configured', async (t) => {
  const { app } = await makeApp({ config: { domain: 'panel.test' } });
  t.after(() => app.close());
  const res = await post(app, '/api/login', GOOD);
  assert.match(res.headers['set-cookie'], /Secure/);
});

test('/api/me needs a session', async (t) => {
  const { app, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  const ok = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { authenticated: true });
  const anon = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anon.statusCode, 401);
  assert.deepEqual(anon.json(), { error: 'unauthorized' });
  const forged = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'craftrcon_sid=nope' } });
  assert.equal(forged.statusCode, 401);
});

test('/api/health stays public', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
});

test('wrong password gives 401 invalid_password', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const res = await post(app, '/api/login', { password: 'nope' });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: 'invalid_password' });
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login never authenticates when no admin password is set', async (t) => {
  const { app } = await makeApp({ password: null });
  t.after(() => app.close());
  for (const payload of [{ password: '' }, { password: 'anything' }, {}]) {
    const res = await post(app, '/api/login', payload);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'invalid_password' });
  }
});

test('5 wrong passwords lock the IP, even for the correct password', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  for (let i = 0; i < 5; i += 1) {
    const res = await post(app, '/api/login', { password: 'wrong' });
    assert.equal(res.statusCode, 401);
  }
  const locked = await post(app, '/api/login', GOOD);
  assert.equal(locked.statusCode, 429);
  const body = locked.json();
  assert.equal(body.error, 'too_many_attempts');
  assert.ok(body.retryAfterMs > 0 && body.retryAfterMs <= 60_000);
});

test('rate limiter doubles the lock each time up to the cap and resets on success', () => {
  let t = 0;
  const rl = createRateLimiter({ maxFails: 2, baseLockMs: 1000, maxLockMs: 3000, now: () => t });
  const attempt = () => {
    assert.equal(rl.check('a').allowed, true);
    rl.fail('a');
  };
  const lockFor = () => {
    attempt();
    attempt();
    return rl.check('a').retryAfterMs;
  };
  assert.equal(lockFor(), 1000);
  t += 1000;
  assert.equal(lockFor(), 2000);
  t += 2000;
  assert.equal(lockFor(), 3000);
  t += 3000;
  assert.equal(lockFor(), 3000);
  assert.equal(rl.check('b').allowed, true, 'other IPs are unaffected');
  t += 3000;
  attempt();
  assert.equal(rl.check('a').allowed, true);
  rl.success('a');
  attempt();
  assert.equal(rl.check('a').allowed, true, 'success clears the failure streak');
});

test('rate limiter counts in-flight attempts against the limit', () => {
  const rl = createRateLimiter({ maxFails: 3, baseLockMs: 1000, now: () => 0 });
  const results = Array.from({ length: 10 }, () => rl.check('a').allowed);
  assert.equal(results.filter(Boolean).length, 3);
  for (let i = 0; i < 3; i += 1) rl.fail('a');
  assert.equal(rl.check('a').retryAfterMs, 1000, 'one burst causes one lock, not an escalation');
  const rl2 = createRateLimiter({ maxFails: 2, now: () => 0 });
  assert.equal(rl2.check('a').allowed, true);
  assert.equal(rl2.check('a').allowed, true);
  assert.equal(rl2.check('a').allowed, false);
  rl2.release('a');
  assert.equal(rl2.check('a').allowed, true, 'release frees the slot without counting a failure');
});

test('concurrent wrong logins cannot exceed the 5-attempt limit', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const results = await Promise.all(
    Array.from({ length: 20 }, () => post(app, '/api/login', { password: 'wrong' })),
  );
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, 5);
  assert.equal(codes.filter((c) => c === 429).length, 15);
  const retry = results.find((r) => r.statusCode === 429).json().retryAfterMs;
  assert.ok(retry <= 60_000, 'a single burst must not escalate the lock');
  const after = await post(app, '/api/login', GOOD);
  assert.equal(after.statusCode, 429);
  assert.ok(after.json().retryAfterMs <= 60_000);
});

test('POST with a foreign Origin is rejected', async (t) => {
  const { app, login } = await makeApp();
  t.after(() => app.close());
  const evil = { host: 'panel.test', origin: 'http://evil.test' };
  const res = await post(app, '/api/login', GOOD, evil);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: 'bad_origin' });

  const headers = await login();
  const authed = await post(app, '/api/logout', undefined, { ...headers, ...evil });
  assert.equal(authed.statusCode, 403);
  const stillValid = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(stillValid.statusCode, 200, 'a rejected logout must not destroy the session');
});

test('POST without Origin or with an unparsable Origin is rejected', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  assert.equal((await post(app, '/api/login', GOOD, { host: TEST_HOST })).statusCode, 403);
  assert.equal((await post(app, '/api/login', GOOD, { host: TEST_HOST, origin: 'null' })).statusCode, 403);
});

test('Origin compares host and port, case-insensitively', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const ok = await post(app, '/api/login', GOOD, { host: 'Panel.Test:8080', origin: 'http://panel.test:8080' });
  assert.equal(ok.statusCode, 204);
  const port = await post(app, '/api/login', GOOD, { host: 'panel.test:8080', origin: 'http://panel.test:9090' });
  assert.equal(port.statusCode, 403);
});

test('X-Forwarded-Host is used only when trustProxy is set', async (t) => {
  const headers = { host: '127.0.0.1:8080', 'x-forwarded-host': 'panel.test', origin: TEST_ORIGIN };

  const proxied = await makeApp({ config: { trustProxy: true } });
  t.after(() => proxied.app.close());
  assert.equal((await post(proxied.app, '/api/login', GOOD, headers)).statusCode, 204);

  const direct = await makeApp();
  t.after(() => direct.app.close());
  assert.equal((await post(direct.app, '/api/login', GOOD, headers)).statusCode, 403);
});

test('GET requests do not need an Origin', async (t) => {
  const { app, login } = await makeApp();
  t.after(() => app.close());
  const { cookie } = await login();
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(res.statusCode, 200);
});

test('a session idle for 8 days is rejected and removed', async (t) => {
  const { app, db, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 8 * 24 * 3600e3);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(res.statusCode, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('using a session refreshes last_seen', async (t) => {
  const { app, db, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  const old = Date.now() - 6 * 24 * 3600e3;
  db.prepare('UPDATE sessions SET last_seen = ?').run(old);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers })).statusCode, 200);
  assert.ok(db.prepare('SELECT last_seen FROM sessions').get().last_seen > old);
});

// Review I1: the session expires after 7 days WITHOUT use, so the cookie's
// Max-Age is renewed on use (at most once per hour per session).
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const cookieOf = (res) => {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('\n') : raw;
};

test('a session used on day 6 gets a fresh 7-day cookie and is still valid after day 7', async (t) => {
  const { app, db, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  const token = headers.cookie.split('=')[1];
  const loginAt = Date.now() - 6 * DAY; // logged in 6 days ago, last used then
  db.prepare('UPDATE sessions SET created_at = ?, last_seen = ?').run(loginAt, loginAt);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(res.statusCode, 200);
  const raw = cookieOf(res);
  assert.ok(raw, 'a used session must get its cookie back');
  assert.ok(raw.startsWith(`craftrcon_sid=${token};`), 'same token, not a new session');
  assert.match(raw, /Max-Age=604800/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Path=\//);
  assert.doesNotMatch(raw, /Secure/);
  // Day 9 after login (3 days after that use): the cookie (expires day 13) and the
  // session are both still valid.
  db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 3 * DAY);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers })).statusCode, 200);
});

test('the cookie is not re-sent on every request: at most once per hour', async (t) => {
  const { app, db, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['set-cookie'], undefined, `request ${i} inside the hour`);
  }
  db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 59 * 60e3);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers })).headers['set-cookie'], undefined);
  db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - HOUR - 1000);
  const renewed = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.match(cookieOf(renewed), /Max-Age=604800/);
  const after = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(after.headers['set-cookie'], undefined, 'renewed once, then quiet for an hour');
});

test('the renewed cookie is Secure when a domain is configured', async (t) => {
  const { app, db, login } = await makeApp({ config: { domain: 'panel.test' } });
  t.after(() => app.close());
  const headers = await login();
  db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 2 * HOUR);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.match(cookieOf(res), /Secure/);
  assert.match(cookieOf(res), /SameSite=Strict/);
});

test('logout after a long pause only clears the cookie', async (t) => {
  const { app, db, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 2 * DAY);
  const res = await post(app, '/api/logout', undefined, headers);
  assert.equal(res.statusCode, 204);
  const raw = cookieOf(res);
  assert.match(raw, /craftrcon_sid=;/);
  assert.doesNotMatch(raw, /craftrcon_sid=[\w-]{43}/);
});

test('only the token hash is stored', async (t) => {
  const { app, db, login } = await makeApp();
  t.after(() => app.close());
  const { cookie } = await login();
  const token = cookie.split('=')[1];
  const { id_hash: stored } = db.prepare('SELECT id_hash FROM sessions').get();
  assert.notEqual(stored, token);
  assert.match(stored, /^[0-9a-f]{64}$/);
});

test('logout destroys the session and clears the cookie', async (t) => {
  const { app, login } = await makeApp();
  t.after(() => app.close());
  const headers = await login();
  const res = await post(app, '/api/logout', undefined, headers);
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['set-cookie'], /craftrcon_sid=;/);
  const after = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.equal(after.statusCode, 401);
});

test('login success and failure are audited with the client IP', async (t) => {
  const { app, services } = await makeApp();
  t.after(() => app.close());
  await post(app, '/api/login', { password: 'wrong' });
  await post(app, '/api/login', GOOD);
  const rows = services.audit.list({});
  assert.deepEqual(
    rows.map((r) => [r.action, r.origin, r.ok, r.detail]),
    [
      ['login_ok', 'auth', true, '127.0.0.1'],
      ['login_fail', 'auth', false, '127.0.0.1'],
    ],
  );
});

test('audit list filters, paginates and purges', async (t) => {
  const { db, services } = await makeApp();
  t.after(() => db.close());
  db.exec("INSERT INTO servers (name, host, rcon_password_enc) VALUES ('s', 'h', 'x')");
  const { audit } = services;
  audit.log({ origin: 'system', action: 'a' });
  audit.log({ serverId: 1, origin: 'ui', action: 'b', detail: 'd', result: 'r' });
  audit.log({ serverId: 1, origin: 'console', action: 'c', ok: false });
  assert.deepEqual(audit.list({ serverId: 1 }).map((r) => r.action), ['c', 'b']);
  const page = audit.list({ limit: 2 });
  assert.deepEqual(page.map((r) => r.action), ['c', 'b']);
  assert.deepEqual(audit.list({ before: page[1].id }).map((r) => r.action), ['a']);
  assert.equal(audit.purge(60_000), 0);
  assert.equal(audit.purge(-1), 3);
  assert.deepEqual(audit.list({}), []);
});

test('the global hook also protects routes registered in plugin scopes', async (t) => {
  const { app, login } = await makeApp();
  t.after(() => app.close());
  app.register(async (child) => {
    child.get('/api/secret', async () => ({ secret: true }));
    child.post('/api/secret', async () => ({ done: true }));
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/secret' })).statusCode, 401);
  assert.equal((await post(app, '/api/secret', {}, { host: TEST_HOST })).statusCode, 403);
  const headers = await login();
  assert.equal((await app.inject({ method: 'GET', url: '/api/secret', headers })).statusCode, 200);
  assert.equal((await post(app, '/api/secret', {}, headers)).statusCode, 200);
});

test('percent-encoded paths cannot bypass the session check', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  for (const url of ['/%61pi/me', '/ap%69/me', '/api/%6De', '/api/me?x=1']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, url);
  }
});

test('percent-encoded paths cannot bypass the Origin check', async (t) => {
  const { app, login } = await makeApp();
  t.after(() => app.close());
  const { cookie } = await login();
  for (const url of ['/%61pi/logout', '/ap%69/logout', '/api/logou%74']) {
    const noOrigin = await post(app, url, undefined, { host: TEST_HOST });
    assert.equal(noOrigin.statusCode, 403, url);
    const evil = await post(app, url, undefined, { host: TEST_HOST, origin: 'http://evil.test', cookie });
    assert.equal(evil.statusCode, 403, url);
  }
  const alive = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(alive.statusCode, 200);
});

test('encoded variants of public routes stay public and unknown URLs expose nothing', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/%61pi/health' })).statusCode, 200);
  const missing = await app.inject({ method: 'GET', url: '/%61pi/nope' });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'not_found' });
  // Outside /api/ an unknown path is a SPA deep link: it gets the static shell only.
  const page = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<div id="app"><\/div>/);
});
