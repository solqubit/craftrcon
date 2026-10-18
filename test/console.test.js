import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TEST_HOST, TEST_ORIGIN } from './helpers.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';
import { createHub } from '../src/services/hub.js';

async function setup(t, fakeOptions = {}) {
  const fake = await startFakeMinecraft({ password: 'goodpw', strict: true, ...fakeOptions });
  t.after(() => fake.close());
  const ctx = await makeApp();
  t.after(async () => {
    ctx.services.manager.closeAll();
    // Injected sockets never see a TCP close, so end them here instead of waiting out the close handshake.
    for (const client of ctx.app.websocketServer.clients) client.terminate();
    await ctx.app.close();
  });
  const headers = await ctx.login();
  const call = (method, url, payload) =>
    ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const created = await call('POST', '/api/servers', {
    name: 'Survival',
    host: '127.0.0.1',
    rconPort: fake.rconPort,
    password: 'goodpw',
  });
  return { ...ctx, fake, headers, call, id: created.json().id };
}

// Connects a live WebSocket and collects every message it receives.
async function connectLive(t, { app, id, headers }, overrides = {}) {
  const ws = await app.injectWS(`/api/servers/${id}/live`, { headers: { ...headers, ...overrides } });
  t.after(() => ws.terminate());
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
    for (const w of waiters.splice(0)) w();
  });
  const next = async (count = 1) => {
    while (messages.length < count) await new Promise((resolve) => waiters.push(resolve));
    return messages;
  };
  return { ws, messages, next };
}

const auditRows = (db) => db.prepare('SELECT * FROM audit ORDER BY id').all();
const historyCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM command_history').get().n;

test('every console route requires a session', async () => {
  const { app } = await makeApp();
  const headers = { host: TEST_HOST, origin: TEST_ORIGIN };
  for (const [method, url] of [
    ['POST', '/api/servers/1/command'],
    ['GET', '/api/servers/1/history'],
    ['GET', '/api/servers/1/favorites'],
    ['POST', '/api/servers/1/favorites'],
    ['PUT', '/api/servers/1/favorites/1'],
    ['DELETE', '/api/servers/1/favorites/1'],
  ]) {
    const res = await app.inject({ method, url, headers, payload: method === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test('a command with a line break or NUL is rejected and never reaches the server', async (t) => {
  const { call, id, fake } = await setup(t);
  const res = await call('POST', `/api/servers/${id}/command`, { command: 'say a\nstop' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid_chars' });
  assert.equal((await call('POST', `/api/servers/${id}/command`, { command: 'say a\0b' })).statusCode, 400);
  assert.equal((await call('POST', `/api/servers/${id}/command`, { command: 'x'.repeat(1500) })).statusCode, 400);
  assert.equal((await call('POST', `/api/servers/${id}/command`, { command: '  ' })).statusCode, 400);
  assert.deepEqual(fake.received, []);
});

test('a slash command runs and returns the server output', async (t) => {
  const { call, id, fake } = await setup(t);
  const res = await call('POST', `/api/servers/${id}/command`, { command: '/list' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.output, 'There are 2 of a max of 20 players online: Steve, Alex');
  assert.equal(body.error, null);
  assert.equal(typeof body.durationMs, 'number');
  assert.equal(typeof body.ts, 'number');
  assert.deepEqual(fake.received, ['list']);
});

test('accented text reaches the server byte for byte', async (t) => {
  const { call, id, fake } = await setup(t);
  const res = await call('POST', `/api/servers/${id}/command`, { command: 'say ¡Hola, señores!' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fake.received, ['say ¡Hola, señores!']);
});

test('only console and ui origins are accepted from clients', async (t) => {
  const { call, id, fake } = await setup(t);
  for (const origin of ['task', 'auth', 'system', 'bogus', 7]) {
    const res = await call('POST', `/api/servers/${id}/command`, { command: 'list', origin });
    assert.equal(res.statusCode, 400, String(origin));
    assert.deepEqual(res.json(), { error: 'validation', fields: { origin: 'invalid' } });
  }
  assert.deepEqual(fake.received, []);
  assert.equal((await call('POST', `/api/servers/${id}/command`, { command: 'list', origin: 'ui' })).statusCode, 200);
});

test('an unknown server is 404 and a bad id is 400', async (t) => {
  const { call } = await setup(t);
  const missing = await call('POST', '/api/servers/999/command', { command: 'list' });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'not_found' });
  assert.equal((await call('GET', '/api/servers/999/history')).statusCode, 404);
  assert.equal((await call('GET', '/api/servers/999/favorites')).statusCode, 404);
  assert.equal((await call('POST', '/api/servers/abc/command', { command: 'list' })).statusCode, 400);
});

test('an RCON failure is a 200 with ok:false and the error code', async (t) => {
  const { call, id, fake, db } = await setup(t);
  await fake.setOnline(false);
  const res = await call('POST', `/api/servers/${id}/command`, { command: 'list' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'ECONNREFUSED');
  assert.equal(body.output, '');
  const [row] = auditRows(db).filter((r) => r.action === 'command');
  assert.equal(row.ok, 0);
  assert.equal(row.result, 'ECONNREFUSED');
});

test('history keeps only console commands, newest first, capped at 200', async (t) => {
  const { call, id, db } = await setup(t);
  for (let i = 1; i <= 205; i++) {
    await call('POST', `/api/servers/${id}/command`, { command: `say n${i}` });
  }
  const history = (await call('GET', `/api/servers/${id}/history`)).json();
  assert.equal(history.length, 200);
  assert.deepEqual(Object.keys(history[0]).sort(), ['command', 'ts']);
  assert.equal(history[0].command, 'say n205');
  assert.equal(history[199].command, 'say n6');
  assert.equal(historyCount(db), 200, 'trimmed on insert, not only on read');
});

test('history is trimmed per server', async (t) => {
  const { call, id, services, db } = await setup(t);
  const other = (
    await call('POST', '/api/servers', { name: 'Other', host: '127.0.0.1', rconPort: 1, password: 'whatever1' })
  ).json().id;
  db.prepare('INSERT INTO command_history (server_id, command, ts) VALUES (?, ?, 1)').run(other, 'say old');
  for (let i = 0; i < 201; i++) {
    await services.commands.run(id, 'say x', { origin: 'console', audit: false, publish: false });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_history WHERE server_id = ?').get(other).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_history WHERE server_id = ?').get(id).n, 200);
});

test('ui commands are audited but kept out of the history', async (t) => {
  const { call, id, db } = await setup(t);
  await call('POST', `/api/servers/${id}/command`, { command: 'list', origin: 'ui' });
  assert.equal(historyCount(db), 0);
  const rows = auditRows(db).filter((r) => r.action === 'command');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, 'ui');
  assert.equal(rows[0].server_id, id);
  assert.equal(rows[0].detail, 'list');
  assert.equal(rows[0].ok, 1);
  assert.equal(rows[0].result, 'There are 2 of a max of 20 players online: Steve, Alex');
});

test('the audit result holds at most the first 500 characters of the output', async (t) => {
  const { call, id, db } = await setup(t, { handlers: { big: () => 'y'.repeat(900) } });
  const res = await call('POST', `/api/servers/${id}/command`, { command: 'big', origin: 'ui' });
  assert.equal(res.json().output.length, 900);
  assert.equal(auditRows(db).find((r) => r.action === 'command').result.length, 500);
});

test('run with audit:false and publish:false leaves no audit row and no message', async (t) => {
  const ctx = await setup(t);
  const live = await connectLive(t, ctx);
  const result = await ctx.services.commands.run(ctx.id, 'list', { origin: 'ui', audit: false, publish: false });
  assert.equal(result.ok, true);
  assert.equal(auditRows(ctx.db).filter((r) => r.action === 'command').length, 0);
  assert.equal(historyCount(ctx.db), 0);
  // A published command afterwards proves nothing was queued before it.
  await ctx.call('POST', `/api/servers/${ctx.id}/command`, { command: 'say hi', origin: 'ui' });
  const messages = await live.next();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].entry.command, 'say hi');
});

test('run rejects an unknown server and an invalid command without executing', async (t) => {
  const { services, fake, id } = await setup(t);
  await assert.rejects(services.commands.run(999, 'list', { origin: 'ui' }), { code: 'NOT_FOUND' });
  await assert.rejects(services.commands.run(id, 'say a\nstop', { origin: 'ui' }), {
    code: 'INVALID_COMMAND',
    reason: 'invalid_chars',
  });
  assert.deepEqual(fake.received, []);
});

test('a live client receives the console entry of a command', async (t) => {
  const ctx = await setup(t);
  const live = await connectLive(t, ctx);
  const res = await ctx.call('POST', `/api/servers/${ctx.id}/command`, { command: '/list' });
  const [message] = await live.next();
  assert.equal(message.type, 'console');
  assert.deepEqual(message.entry, {
    ts: res.json().ts,
    origin: 'console',
    command: 'list',
    ok: true,
    output: 'There are 2 of a max of 20 players online: Steve, Alex',
    error: null,
  });
});

test('a live client only receives messages of its own server', async (t) => {
  const ctx = await setup(t);
  const otherFake = await startFakeMinecraft({ password: 'goodpw', strict: true });
  t.after(() => otherFake.close());
  const other = (
    await ctx.call('POST', '/api/servers', {
      name: 'Other',
      host: '127.0.0.1',
      rconPort: otherFake.rconPort,
      password: 'goodpw',
    })
  ).json().id;
  const live = await connectLive(t, ctx);
  await ctx.call('POST', `/api/servers/${other}/command`, { command: 'say elsewhere' });
  await ctx.call('POST', `/api/servers/${ctx.id}/command`, { command: 'say here' });
  const messages = await live.next();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].entry.command, 'say here');
});

test('closing the socket unsubscribes it from the hub (real network socket)', async (t) => {
  const ctx = await setup(t);
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = ctx.app.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/servers/${ctx.id}/live`, {
    headers: { cookie: ctx.headers.cookie, origin: `http://127.0.0.1:${port}` },
  });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket failed to open')));
  });
  assert.deepEqual(ctx.services.hub.subscribedServerIds(), [ctx.id]);

  ws.close();
  for (let i = 0; i < 100 && ctx.services.hub.subscribedServerIds().length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(ctx.services.hub.subscribedServerIds(), []);
});

test('the live upgrade is refused for a foreign Origin, a missing Origin, no session and an unknown server', async (t) => {
  const ctx = await setup(t);
  const attempt = (overrides, id = ctx.id) =>
    ctx.app.injectWS(`/api/servers/${id}/live`, { headers: { ...ctx.headers, ...overrides } });

  await assert.rejects(attempt({ origin: 'http://evil.test' }), /403/);
  await assert.rejects(attempt({ origin: undefined }), /403/);
  await assert.rejects(attempt({ cookie: undefined }), /401/);
  await assert.rejects(attempt({ cookie: 'craftrcon_sid=nope' }), /401/);
  await assert.rejects(attempt({}, 999), /404/);
  assert.deepEqual(ctx.services.hub.subscribedServerIds(), []);
});

test('hub: delivers to subscribers of a server, skips sockets that are not open', () => {
  const hub = createHub();
  const sent = [];
  const socket = (name, readyState = 1) => ({ readyState, send: (data) => sent.push([name, data]) });
  const a = socket('a');
  const b = socket('b');
  const closing = socket('closing', 2);
  const elsewhere = socket('elsewhere');
  hub.subscribe(1, a);
  hub.subscribe(1, b);
  hub.subscribe(1, closing);
  hub.subscribe(2, elsewhere);
  assert.deepEqual(hub.subscribedServerIds().sort(), [1, 2]);

  hub.publish(1, { type: 'x', n: 1 });
  assert.deepEqual(sent, [
    ['a', '{"type":"x","n":1}'],
    ['b', '{"type":"x","n":1}'],
  ]);

  hub.unsubscribe(a);
  hub.unsubscribe(b);
  hub.unsubscribe(closing);
  hub.unsubscribe(closing); // idempotent
  assert.deepEqual(hub.subscribedServerIds(), [2]);
  hub.publish(1, { type: 'y' });
  assert.equal(sent.length, 2);
});

test('hub: a socket that throws does not block the others', () => {
  const hub = createHub();
  const got = [];
  hub.subscribe(1, {
    readyState: 1,
    send() {
      throw new Error('broken pipe');
    },
  });
  hub.subscribe(1, { readyState: 1, send: (data) => got.push(data) });
  hub.publish(1, { ok: true });
  assert.deepEqual(got, ['{"ok":true}']);
});

test('favorites: full CRUD with ordering', async (t) => {
  const { call, id } = await setup(t);
  const base = `/api/servers/${id}/favorites`;

  assert.deepEqual((await call('GET', base)).json(), []);

  const first = await call('POST', base, { label: ' Day ', command: '/time set day' });
  assert.equal(first.statusCode, 201);
  assert.deepEqual(first.json(), { id: 1, label: 'Day', command: 'time set day', position: 0 });
  const second = (await call('POST', base, { label: 'Night', command: 'time set night' })).json();
  assert.equal(second.position, 1, 'default position appends');
  const third = (await call('POST', base, { label: 'Clear', command: 'weather clear', position: 0 })).json();
  assert.equal(third.position, 0);

  const list = (await call('GET', base)).json();
  assert.deepEqual(
    list.map((f) => f.label),
    ['Day', 'Clear', 'Night'],
    'ordered by position, then id',
  );

  const renamed = await call('PUT', `${base}/${second.id}`, { label: 'Dusk' });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(renamed.json(), { id: second.id, label: 'Dusk', command: 'time set night', position: 1 });
  const moved = (await call('PUT', `${base}/${second.id}`, { position: 0, command: 'time set 13000' })).json();
  assert.equal(moved.position, 0);
  assert.equal(moved.command, 'time set 13000');
  assert.equal(moved.label, 'Dusk');
  assert.deepEqual(
    (await call('GET', base)).json().map((f) => f.label),
    ['Day', 'Dusk', 'Clear'],
  );

  const del = await call('DELETE', `${base}/${first.json().id}`);
  assert.equal(del.statusCode, 204);
  assert.equal((await call('DELETE', `${base}/${first.json().id}`)).statusCode, 404);
  assert.equal((await call('PUT', `${base}/${first.json().id}`, { label: 'x' })).statusCode, 404);
  assert.equal((await call('GET', base)).json().length, 2);
});

test('favorites: input is validated', async (t) => {
  const { call, id } = await setup(t);
  const base = `/api/servers/${id}/favorites`;
  const post = (body) => call('POST', base, body);

  const empty = await post({});
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.json(), { error: 'validation', fields: { label: 'invalid', command: 'empty' } });
  assert.deepEqual((await post({ label: '   ', command: 'list' })).json().fields, { label: 'required' });
  assert.deepEqual((await post({ label: 'x'.repeat(41), command: 'list' })).json().fields, { label: 'too_long' });
  assert.equal((await post({ label: 'x'.repeat(40), command: 'list' })).statusCode, 201);
  assert.deepEqual((await post({ label: 'a', command: 'say a\nstop' })).json().fields, { command: 'invalid_chars' });
  for (const position of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual((await post({ label: 'a', command: 'list', position })).json().fields, { position: 'invalid' });
  }
  const fav = (await post({ label: 'ok', command: 'list' })).json();
  assert.equal((await call('PUT', `${base}/${fav.id}`, { command: 'a\nb' })).statusCode, 400);
  assert.equal((await call('PUT', `${base}/${fav.id}`, { label: '' })).statusCode, 400);
  assert.equal((await call('PUT', `${base}/abc`, {})).statusCode, 400);
});

test('favorites of another server are not reachable', async (t) => {
  const { call, id } = await setup(t);
  const other = (
    await call('POST', '/api/servers', { name: 'Other', host: '127.0.0.1', rconPort: 1, password: 'whatever1' })
  ).json().id;
  const fav = (await call('POST', `/api/servers/${id}/favorites`, { label: 'a', command: 'list' })).json();
  assert.equal((await call('PUT', `/api/servers/${other}/favorites/${fav.id}`, { label: 'b' })).statusCode, 404);
  assert.equal((await call('DELETE', `/api/servers/${other}/favorites/${fav.id}`)).statusCode, 404);
  assert.deepEqual((await call('GET', `/api/servers/${other}/favorites`)).json(), []);
  assert.equal((await call('GET', `/api/servers/${id}/favorites`)).json()[0].label, 'a');
});

test('deleting a server removes its history and favorites', async (t) => {
  const { call, id, db } = await setup(t);
  await call('POST', `/api/servers/${id}/command`, { command: 'list' });
  await call('POST', `/api/servers/${id}/favorites`, { label: 'a', command: 'list' });
  assert.equal((await call('DELETE', `/api/servers/${id}`)).statusCode, 204);
  assert.equal(historyCount(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM favorites').get().n, 0);
});
