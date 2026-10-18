import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TEST_HOST, TEST_ORIGIN } from './helpers.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';
import { createStatus } from '../src/services/status.js';
import { createSampler } from '../src/services/sampler.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

async function setup(t, fakeOptions = {}) {
  const fake = await startFakeMinecraft({ password: 'goodpw', strict: true, ...fakeOptions });
  t.after(() => fake.close());
  const ctx = await makeApp();
  t.after(async () => {
    ctx.services.manager.closeAll();
    await ctx.app.close();
  });
  const headers = await ctx.login();
  const call = (method, url, payload) =>
    ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const created = await call('POST', '/api/servers', {
    name: 'Survival',
    host: '127.0.0.1',
    rconPort: fake.rconPort,
    gamePort: fake.gamePort,
    password: 'goodpw',
  });
  assert.equal(created.statusCode, 201);
  return { ...ctx, fake, headers, call, id: created.json().id };
}

const tpsCommands = (fake) => fake.received.filter((c) => c === 'tps').length;

test('status reports an online server with its TPS', async (t) => {
  const { services, id } = await setup(t);
  const status = await services.status.get(id);
  assert.deepEqual(status, {
    online: true,
    version: 'Paper 1.21.4',
    software: 'Paper',
    players: { online: 2, max: 20 },
    motd: status.motd,
    latencyMs: status.latencyMs,
    tps: [20, 20, 19.97],
    tpsSupported: true,
  });
  assert.equal(typeof status.motd, 'string');
  assert.equal(typeof status.latencyMs, 'number');
});

test('a server without a tps command is reported unsupported and not asked again until forgotten', async (t) => {
  const { services, fake, id, call } = await setup(t, { handlers: { tps: () => 'Unknown command' } });
  let clock = 0;
  const status = createStatus({ servers: services.servers, commands: services.commands, now: () => clock });

  const first = await status.get(id);
  assert.equal(first.online, true);
  assert.equal(first.tps, null);
  assert.equal(first.tpsSupported, false);
  assert.equal(tpsCommands(fake), 1);

  clock += 10_000; // cache expired
  assert.equal((await status.get(id)).tpsSupported, false);
  assert.equal(tpsCommands(fake), 1, 'not asked again');

  status.forget(id);
  await status.get(id);
  assert.equal(tpsCommands(fake), 2, 'asked again after forget');

  // Editing the server through the API forgets it too.
  await services.status.get(id);
  assert.equal(tpsCommands(fake), 3);
  const put = await call('PUT', `/api/servers/${id}`, { name: 'Renamed' });
  assert.equal(put.statusCode, 200);
  await services.status.get(id);
  assert.equal(tpsCommands(fake), 4);
});

test('a failed RCON call is not remembered as unsupported', async () => {
  let tpsCalls = 0;
  const servers = { get: () => ({ id: 1, host: 'h', gamePort: 25565 }) };
  const commands = {
    run: async () => {
      tpsCalls++;
      return tpsCalls === 1 ? { ok: false, output: '', error: 'TIMEOUT' } : { ok: true, output: 'TPS from last 1m, 5m, 15m: 20, 20, 20' };
    },
  };
  const ping = async () => ({ online: true, version: 'v', software: 'Paper', players: { online: 0, max: 5 }, motd: '', latencyMs: 1 });
  let clock = 0;
  const status = createStatus({ servers, commands, ping, now: () => clock });

  const failed = await status.get(1);
  assert.equal(failed.tps, null);
  assert.equal(failed.tpsSupported, false);
  clock += 10_000;
  const recovered = await status.get(1);
  assert.deepEqual(recovered.tps, [20, 20, 20]);
  assert.equal(recovered.tpsSupported, true);
});

test('status is cached for 5 s and concurrent calls share one probe', async () => {
  let pings = 0;
  const servers = { get: () => ({ id: 1, host: 'h', gamePort: 25565 }) };
  const commands = { run: async () => ({ ok: true, output: 'TPS from last 1m, 5m, 15m: 20, 20, 20' }) };
  const ping = async () => {
    pings++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { online: true, version: 'v', software: 'Paper', players: { online: 0, max: 5 }, motd: '', latencyMs: 1 };
  };
  let clock = 0;
  const status = createStatus({ servers, commands, ping, now: () => clock });

  const [a, b] = await Promise.all([status.get(1), status.get(1)]);
  assert.equal(a, b);
  assert.equal(pings, 1);

  clock += 4_999;
  await status.get(1);
  assert.equal(pings, 1, 'still cached');
  clock += 1;
  await status.get(1);
  assert.equal(pings, 2, 'expired after 5 s');
});

test('an offline server answers 200 with an offline status, quickly', async (t) => {
  const { fake, id, call } = await setup(t);
  await fake.setOnline(false);

  const started = performance.now();
  const res = await call('GET', `/api/servers/${id}/status`);
  assert.ok(performance.now() - started < 3500);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.online, false);
  assert.equal(typeof body.error, 'string');
  assert.deepEqual(
    { ...body, error: undefined },
    {
      online: false,
      error: undefined,
      version: null,
      software: null,
      players: null,
      motd: null,
      latencyMs: null,
      tps: null,
      tpsSupported: false,
    },
  );
});

test('GET /api/servers/status maps every server id to { online, players }', async (t) => {
  const { call, id } = await setup(t);
  const second = await startFakeMinecraft({ password: 'goodpw', strict: true });
  t.after(() => second.close());
  const other = await call('POST', '/api/servers', {
    name: 'Creative',
    host: '127.0.0.1',
    rconPort: second.rconPort,
    gamePort: second.gamePort,
    password: 'goodpw',
  });
  await second.setOnline(false);

  const res = await call('GET', '/api/servers/status');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    [id]: { online: true, players: { online: 2, max: 20 } },
    [other.json().id]: { online: false, players: null },
  });
});

test('status routes: 404 for an unknown server, 400 for a bad id, session required', async (t) => {
  const { app, call } = await setup(t);
  assert.equal((await call('GET', '/api/servers/999/status')).statusCode, 404);
  assert.equal((await call('GET', '/api/servers/abc/status')).statusCode, 400);
  assert.equal((await call('GET', '/api/servers/999/samples')).statusCode, 404);
  const anon = { host: TEST_HOST, origin: TEST_ORIGIN };
  for (const url of ['/api/servers/status', '/api/servers/1/status', '/api/servers/1/samples']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: anon })).statusCode, 401, url);
  }
});

test('tick stores one sample per online server and drops samples older than the retention', async (t) => {
  const { db, services, id, call } = await setup(t);
  const offline = await startFakeMinecraft({ password: 'goodpw', strict: true });
  t.after(() => offline.close());
  const down = await call('POST', '/api/servers', {
    name: 'Down',
    host: '127.0.0.1',
    rconPort: offline.rconPort,
    gamePort: offline.gamePort,
    password: 'goodpw',
  });
  assert.equal(down.statusCode, 201);
  await offline.setOnline(false);

  const now = Date.now();
  const insert = db.prepare('INSERT INTO player_samples (server_id, ts, online, max) VALUES (?, ?, 1, 20)');
  insert.run(id, now - 8 * DAY);
  insert.run(id, now - 6 * DAY);
  const sampler = createSampler({
    db,
    servers: services.servers,
    status: services.status,
    hub: services.hub,
    now: () => now,
  });
  await sampler.tick();

  const rows = db.prepare('SELECT * FROM player_samples ORDER BY ts').all();
  assert.deepEqual(
    rows.map((r) => [r.server_id, r.ts, r.online, r.max]),
    [
      [id, now - 6 * DAY, 1, 20],
      [id, now, 2, 20],
    ],
  );
});

test('samples?range filters by range and returns ascending timestamps', async (t) => {
  const { db, id, call } = await setup(t);
  const now = Date.now();
  const insert = db.prepare('INSERT INTO player_samples (server_id, ts, online, max) VALUES (?, ?, ?, 20)');
  insert.run(id, now - 3 * DAY, 1);
  insert.run(id, now - 2 * HOUR, 5);
  insert.run(id, now - 25 * HOUR, 3);
  insert.run(id, now - 1 * HOUR, 7);

  const day = await call('GET', `/api/servers/${id}/samples?range=24h`);
  assert.equal(day.statusCode, 200);
  assert.deepEqual(day.json().map((s) => s.online), [5, 7]);
  assert.deepEqual(Object.keys(day.json()[0]).sort(), ['max', 'online', 'ts']);

  const dflt = await call('GET', `/api/servers/${id}/samples`);
  assert.deepEqual(dflt.json(), day.json());

  const week = await call('GET', `/api/servers/${id}/samples?range=7d`);
  assert.deepEqual(week.json().map((s) => s.online), [1, 3, 5, 7]);
  const ts = week.json().map((s) => s.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));

  for (const bad of ['1h', '', '24H', 'constructor']) {
    const res = await call('GET', `/api/servers/${id}/samples?range=${bad}`);
    assert.equal(res.statusCode, 400, bad);
    assert.deepEqual(res.json(), { error: 'validation', fields: { range: 'invalid' } });
  }
});

test('the live status push only reaches servers with subscribers', async () => {
  const published = [];
  const sockets = new Set();
  const hub = {
    subscribedServerIds: () => [...sockets],
    publish: (id, message) => published.push([id, message]),
  };
  sockets.add(2);
  const statuses = { get: async (id) => ({ online: id === 2 }) };
  const sampler = createSampler({ db: dbStub(), servers: { list: () => [{ id: 1 }, { id: 2 }] }, status: statuses, hub });
  await sampler.push();
  assert.deepEqual(published, [[2, { type: 'status', status: { online: true } }]]);
});

test('start() runs the timers (unref\'d) and stop() clears them', async () => {
  const published = [];
  const hub = { subscribedServerIds: () => [1], publish: (id, m) => published.push([id, m]) };
  const sampler = createSampler({
    db: dbStub(),
    servers: { list: () => [] },
    status: { get: async () => ({ online: true }) },
    hub,
    intervalMs: 10_000,
    pushIntervalMs: 10,
  });
  sampler.start();
  sampler.start(); // idempotent
  await new Promise((resolve) => setTimeout(resolve, 80));
  sampler.stop();
  const seen = published.length;
  assert.ok(seen >= 1, 'pushed while running');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(published.length, seen, 'nothing after stop');
});

// Enough of a database for samplers that never touch it.
function dbStub() {
  return { prepare: () => ({ run() {}, all: () => [] }) };
}
