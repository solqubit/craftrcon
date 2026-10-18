import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { makeApp } from './helpers.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';

const PW = 'secretpw';

async function setup(t) {
  const ctx = await makeApp();
  t.after(() => ctx.services.manager.closeAll());
  const headers = await ctx.login();
  const call = (method, url, payload) =>
    ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { ...ctx, headers, call };
}

const valid = (over = {}) => ({
  name: 'Survival',
  host: '10.0.0.5',
  rconPort: 25575,
  password: PW,
  ...over,
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('every server route requires a session', async () => {
  const { app } = await makeApp();
  const headers = { host: 'panel.test', origin: 'http://panel.test' };
  for (const [method, url] of [
    ['GET', '/api/servers'],
    ['POST', '/api/servers'],
    ['POST', '/api/servers/test'],
    ['GET', '/api/servers/1'],
    ['PUT', '/api/servers/1'],
    ['DELETE', '/api/servers/1'],
  ]) {
    const res = await app.inject({ method, url, headers, payload: method === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test('create returns the public object and applies defaults', async (t) => {
  const { call } = await setup(t);
  const res = await call('POST', '/api/servers', valid({ name: '  Survival  ', host: ' 10.0.0.5 ' }));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), {
    id: 1,
    name: 'Survival',
    host: '10.0.0.5',
    rconPort: 25575,
    gamePort: 25565,
    icon: 'mountain',
    color: 'emerald',
  });
});

test('no response ever contains the password or its ciphertext', async (t) => {
  const { call, db } = await setup(t);
  const created = await call('POST', '/api/servers', valid({ icon: 'sword', color: 'rose', gamePort: 25570 }));
  const id = created.json().id;
  const bodies = [
    created.body,
    (await call('GET', '/api/servers')).body,
    (await call('GET', `/api/servers/${id}`)).body,
    (await call('PUT', `/api/servers/${id}`, { name: 'Renamed', password: 'otherpw1' })).body,
  ];
  const enc = db.prepare('SELECT rcon_password_enc FROM servers WHERE id = ?').get(id).rcon_password_enc;
  assert.ok(!enc.includes(PW), 'stored value is encrypted');
  for (const body of bodies) {
    assert.ok(!body.includes(PW));
    assert.ok(!body.includes('otherpw1'));
    assert.ok(!body.includes('rcon_password_enc'));
    assert.ok(!body.includes(enc));
  }
  const list = (await call('GET', '/api/servers')).json();
  assert.deepEqual(Object.keys(list[0]).sort(), ['color', 'gamePort', 'host', 'icon', 'id', 'name', 'rconPort']);
});

test('duplicate names conflict regardless of case', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('POST', '/api/servers', valid())).statusCode, 201);
  const dup = await call('POST', '/api/servers', valid({ name: 'SURVIVAL' }));
  assert.equal(dup.statusCode, 409);
  assert.deepEqual(dup.json(), { error: 'name_taken' });

  const other = (await call('POST', '/api/servers', valid({ name: 'Creative' }))).json();
  const rename = await call('PUT', `/api/servers/${other.id}`, { name: 'survival' });
  assert.equal(rename.statusCode, 409);
  assert.deepEqual(rename.json(), { error: 'name_taken' });
  const same = await call('PUT', `/api/servers/${other.id}`, { name: 'CREATIVE' });
  assert.equal(same.statusCode, 200, 'a server may change the case of its own name');
});

test('PUT without password keeps the old one, with a new one replaces it', async (t) => {
  const { call, services } = await setup(t);
  const { id } = (await call('POST', '/api/servers', valid())).json();

  const keep = await call('PUT', `/api/servers/${id}`, { name: 'Renamed', host: 'mc.example.com' });
  assert.equal(keep.statusCode, 200);
  assert.equal(keep.json().name, 'Renamed');
  assert.equal(keep.json().host, 'mc.example.com');
  assert.equal(keep.json().rconPort, 25575, 'absent fields keep their value');
  assert.deepEqual(services.servers.credentials(id), {
    host: 'mc.example.com',
    rcon_port: 25575,
    password: PW,
  });

  await call('PUT', `/api/servers/${id}`, { password: '' });
  assert.equal(services.servers.credentials(id).password, PW, 'empty password means unchanged');

  await call('PUT', `/api/servers/${id}`, { password: 'brandnew', rconPort: 25580 });
  assert.deepEqual(services.servers.credentials(id), {
    host: 'mc.example.com',
    rcon_port: 25580,
    password: 'brandnew',
  });
});

test('update and delete invalidate the cached connection', async (t) => {
  const { call, services } = await setup(t);
  const calls = [];
  const original = services.manager.invalidate.bind(services.manager);
  services.manager.invalidate = (id) => {
    calls.push(id);
    original(id);
  };
  const { id } = (await call('POST', '/api/servers', valid())).json();
  assert.deepEqual(calls, []);
  await call('PUT', `/api/servers/${id}`, { color: 'sky' });
  assert.deepEqual(calls, [id], 'any field change invalidates');
  await call('DELETE', `/api/servers/${id}`);
  assert.deepEqual(calls, [id, id]);
});

test('DELETE removes the server and everything that belongs to it', async (t) => {
  const { call, db } = await setup(t);
  const { id } = (await call('POST', '/api/servers', valid())).json();
  db.prepare('INSERT INTO favorites (server_id, label, command, position) VALUES (?, ?, ?, 0)').run(id, 'x', 'list');
  db.prepare('INSERT INTO command_history (server_id, command, ts) VALUES (?, ?, 1)').run(id, 'list');

  const res = await call('DELETE', `/api/servers/${id}`);
  assert.equal(res.statusCode, 204);
  assert.equal((await call('GET', '/api/servers')).json().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM favorites').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_history').get().n, 0);
  assert.equal((await call('GET', `/api/servers/${id}`)).statusCode, 404);
});

test('audit records create, update and delete without the password', async (t) => {
  const { call, services, db } = await setup(t);
  const { id } = (await call('POST', '/api/servers', valid())).json();
  await call('PUT', `/api/servers/${id}`, { name: 'Renamed', password: 'otherpw1' });
  await call('POST', '/api/servers/test', { host: '127.0.0.1', rconPort: await freePort(), password: 'testpw99' });

  const summarize = () =>
    services.audit
      .list({ limit: 50 })
      .filter((r) => r.origin === 'ui')
      .map((r) => [r.origin, r.action, r.server_id, r.detail, r.ok]);
  assert.deepEqual(summarize(), [
    ['ui', 'server_update', id, 'Renamed', true],
    ['ui', 'server_create', id, 'Survival', true],
  ]);

  // The schema cascades a server's audit rows away with it, so the delete is
  // logged with no server_id and the name in detail.
  await call('DELETE', `/api/servers/${id}`);
  assert.deepEqual(summarize(), [['ui', 'server_delete', null, 'Renamed', true]]);

  const dump = JSON.stringify(db.prepare('SELECT * FROM audit').all());
  for (const secret of [PW, 'otherpw1', 'testpw99']) assert.ok(!dump.includes(secret), secret);
});

test('validation errors name the offending fields', async (t) => {
  const { call } = await setup(t);
  const bad = await call('POST', '/api/servers', {
    name: '   ',
    host: 5,
    rconPort: 0,
    gamePort: 70000,
    icon: 'banana',
    color: 'plaid',
  });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), {
    error: 'validation',
    fields: {
      name: 'required',
      host: 'invalid',
      rconPort: 'invalid',
      gamePort: 'invalid',
      icon: 'invalid',
      color: 'invalid',
      password: 'required',
    },
  });

  const long = await call('POST', '/api/servers', valid({ name: 'x'.repeat(33) }));
  assert.deepEqual(long.json().fields, { name: 'too_long' });
  const ok = await call('POST', '/api/servers', valid({ name: 'x'.repeat(32) }));
  assert.equal(ok.statusCode, 201);

  const empty = await call('POST', '/api/servers', valid({ host: '  ' }));
  assert.deepEqual(empty.json().fields, { host: 'required' });
  const frac = await call('POST', '/api/servers', valid({ name: 'Other', rconPort: 25575.5 }));
  assert.deepEqual(frac.json().fields, { rconPort: 'invalid' });
  const noBody = await call('POST', '/api/servers', []);
  assert.equal(noBody.statusCode, 400);
  assert.equal(noBody.json().error, 'validation');
});

test('update validates what it receives', async (t) => {
  const { call } = await setup(t);
  const { id } = (await call('POST', '/api/servers', valid())).json();
  const bad = await call('PUT', `/api/servers/${id}`, { name: '', rconPort: 'abc', color: 'plaid' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), {
    error: 'validation',
    fields: { name: 'required', rconPort: 'invalid', color: 'invalid' },
  });
  assert.equal((await call('GET', `/api/servers/${id}`)).json().name, 'Survival', 'nothing was changed');
});

test('unknown ids answer 404 and malformed ids answer 400', async (t) => {
  const { call } = await setup(t);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await call(method, '/api/servers/99', method === 'PUT' ? valid() : undefined);
    assert.equal(res.statusCode, 404, method);
    assert.deepEqual(res.json(), { error: 'not_found' });
  }
  for (const bad of ['0', '-1', 'abc', '1.5', '1e3']) {
    const res = await call('GET', `/api/servers/${bad}`);
    assert.equal(res.statusCode, 400, bad);
    assert.deepEqual(res.json(), { error: 'validation', fields: { id: 'invalid' } });
  }
});

test('connection test succeeds against the fake server', async (t) => {
  const { call } = await setup(t);
  const fake = await startFakeMinecraft({ password: 'goodpw' });
  t.after(() => fake.close());
  const res = await call('POST', '/api/servers/test', { host: '127.0.0.1', rconPort: fake.rconPort, password: 'goodpw' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.latencyMs, 'number');
  assert.ok(body.latencyMs >= 0 && body.latencyMs < 5000);
});

test('connection test reports the RconError code', async (t) => {
  const { call } = await setup(t);
  const fake = await startFakeMinecraft({ password: 'goodpw' });
  t.after(() => fake.close());

  const badAuth = await call('POST', '/api/servers/test', { host: '127.0.0.1', rconPort: fake.rconPort, password: 'wrong' });
  assert.equal(badAuth.statusCode, 200);
  assert.deepEqual(badAuth.json(), { ok: false, error: 'AUTH_FAILED' });

  const refused = await call('POST', '/api/servers/test', { host: '127.0.0.1', rconPort: await freePort(), password: 'x' });
  assert.deepEqual(refused.json(), { ok: false, error: 'ECONNREFUSED' });
});

test('connection test falls back to the stored password when given an id', async (t) => {
  const { call } = await setup(t);
  const fake = await startFakeMinecraft({ password: 'goodpw' });
  t.after(() => fake.close());
  const { id } = (
    await call('POST', '/api/servers', valid({ host: '127.0.0.1', rconPort: fake.rconPort, password: 'goodpw' }))
  ).json();

  const stored = await call('POST', '/api/servers/test', { id, host: '127.0.0.1', rconPort: fake.rconPort });
  assert.equal(stored.json().ok, true);
  const emptyPw = await call('POST', '/api/servers/test', { id, host: '127.0.0.1', rconPort: fake.rconPort, password: '' });
  assert.equal(emptyPw.json().ok, true);
  const override = await call('POST', '/api/servers/test', { id, host: '127.0.0.1', rconPort: fake.rconPort, password: 'nope' });
  assert.deepEqual(override.json(), { ok: false, error: 'AUTH_FAILED' });

  const missing = await call('POST', '/api/servers/test', { id: 999, host: '127.0.0.1', rconPort: fake.rconPort });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'not_found' });
  const missingWithPw = await call('POST', '/api/servers/test', { id: 999, host: '127.0.0.1', rconPort: fake.rconPort, password: 'goodpw' });
  assert.equal(missingWithPw.statusCode, 404);
});

test('connection test validates its input and never touches the shared manager', async (t) => {
  const { call, services } = await setup(t);
  services.manager.get = () => assert.fail('manager must not be used by the test route');
  const noPassword = await call('POST', '/api/servers/test', { host: '127.0.0.1', rconPort: 25575 });
  assert.equal(noPassword.statusCode, 400);
  assert.deepEqual(noPassword.json(), { error: 'validation', fields: { password: 'required' } });
  const bad = await call('POST', '/api/servers/test', { host: '', rconPort: 99999, password: 'x' });
  assert.deepEqual(bad.json(), { error: 'validation', fields: { host: 'required', rconPort: 'invalid' } });
});

test('the stored password is never sent to a host or port other than the saved one', async (t) => {
  const { call } = await setup(t);
  const saved = await startFakeMinecraft({ password: 'goodpw' });
  t.after(() => saved.close());
  const { id } = (
    await call('POST', '/api/servers', valid({ host: '127.0.0.1', rconPort: saved.rconPort, password: 'goodpw' }))
  ).json();

  // A listener standing in for an attacker: it must not even get a connection.
  let connections = 0;
  const bytes = [];
  const rogue = net.createServer((socket) => {
    connections += 1;
    socket.on('data', (chunk) => bytes.push(chunk));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => rogue.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => rogue.close(resolve)));
  const roguePort = rogue.address().port;

  const wrongPort = await call('POST', '/api/servers/test', { id, host: '127.0.0.1', rconPort: roguePort });
  assert.equal(wrongPort.statusCode, 400);
  assert.deepEqual(wrongPort.json(), { error: 'validation', fields: { password: 'required' } });

  const wrongHost = await call('POST', '/api/servers/test', { id, host: 'localhost', rconPort: saved.rconPort });
  assert.equal(wrongHost.statusCode, 400);
  assert.deepEqual(wrongHost.json(), { error: 'validation', fields: { password: 'required' } });

  const defaultPort = await call('POST', '/api/servers/test', { id, host: '127.0.0.1' });
  assert.equal(defaultPort.statusCode, 400, 'an omitted port is not the saved port');

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(connections, 0, 'nothing connected to the other address');
  assert.equal(Buffer.concat(bytes).length, 0);
  assert.deepEqual(saved.received, []);

  // Same target (host compared trimmed and case-insensitively) still works.
  const same = await call('POST', '/api/servers/test', { id, host: ' 127.0.0.1 ', rconPort: saved.rconPort });
  assert.equal(same.json().ok, true);

  // An explicit password may go anywhere: the caller supplied it themselves.
  const explicit = await call('POST', '/api/servers/test', { id, host: '127.0.0.1', rconPort: roguePort, password: 'mine' });
  assert.equal(explicit.statusCode, 200);
  assert.equal(explicit.json().ok, false);
});

test('connection test applies the same length caps as create', async (t) => {
  const { call } = await setup(t);
  const res = await call('POST', '/api/servers/test', {
    host: 'h'.repeat(256),
    rconPort: 25575,
    password: 'p'.repeat(513),
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'validation', fields: { host: 'too_long', password: 'too_long' } });
});
