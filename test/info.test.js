import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TEST_HOST, TEST_ORIGIN } from './helpers.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';
import { GAMERULES } from '../public/js/data/gamerules.js';

const GLUED_BANS =
  'There are 2 ban(s):Steve was banned by Server: Banned by an operator.GriefingAlex was banned by Dami: Spam';
const UNKNOWN_RULE = 'Incorrect argument for command at position 9: gamerule <--[HERE]';

async function setup(t, fakeOptions = {}) {
  const fake = await startFakeMinecraft({ password: 'goodpw', ...fakeOptions });
  t.after(() => fake.close());
  const ctx = await makeApp();
  t.after(async () => {
    ctx.services.manager.closeAll();
    await ctx.app.close();
  });
  const headers = await ctx.login();
  const call = (method, url) => ctx.app.inject({ method, url, headers });
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/servers',
    headers,
    payload: {
      name: 'Survival',
      host: '127.0.0.1',
      rconPort: fake.rconPort,
      gamePort: fake.gamePort,
      password: 'goodpw',
    },
  });
  assert.equal(created.statusCode, 201);
  const published = [];
  ctx.services.hub.publish = (id, message) => published.push([id, message]);
  const auditRows = ctx.services.audit.list().length; // login + server create
  return { ...ctx, fake, headers, call, id: created.json().id, published, auditRows };
}

const noTrace = ({ services, published, auditRows }) => {
  assert.equal(services.audit.list().length, auditRows, 'no new audit rows');
  assert.deepEqual(published, [], 'nothing on the live stream');
};

test('GET players parses the list answer', async (t) => {
  const ctx = await setup(t);
  const res = await ctx.call('GET', `/api/servers/${ctx.id}/players`);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { online: 2, max: 20, players: ['Steve', 'Alex'] });
  noTrace(ctx);
});

test('GET players returns { raw } for an unrecognized answer', async (t) => {
  const ctx = await setup(t, { handlers: { list: () => 'something unexpected' } });
  const res = await ctx.call('GET', `/api/servers/${ctx.id}/players`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { raw: 'something unexpected' });
});

test('GET bans parses the concatenated banlist format', async (t) => {
  const ctx = await setup(t, { handlers: { banlist: () => GLUED_BANS } });
  const res = await ctx.call('GET', `/api/servers/${ctx.id}/bans`);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().entries, [
    { target: 'Steve', source: 'Server', reason: 'Banned by an operator.' },
    { target: 'GriefingAlex', source: 'Dami', reason: 'Spam' },
  ]);
  noTrace(ctx);
});

test('GET bans selects players or ips, defaulting to players', async (t) => {
  const asked = [];
  const ctx = await setup(t, {
    handlers: {
      banlist: (args) => {
        asked.push(args);
        return 'There are no bans';
      },
    },
  });
  for (const url of ['/bans', '/bans?type=players', '/bans?type=ips']) {
    const res = await ctx.call('GET', `/api/servers/${ctx.id}${url}`);
    assert.equal(res.statusCode, 200, url);
    assert.deepEqual(res.json(), { entries: [] });
  }
  assert.deepEqual(asked, ['players', 'players', 'ips']);

  for (const bad of ['ip', 'PLAYERS', '', 'constructor', 'players%20x']) {
    const res = await ctx.call('GET', `/api/servers/${ctx.id}/bans?type=${bad}`);
    assert.equal(res.statusCode, 400, bad);
    assert.deepEqual(res.json(), { error: 'validation', fields: { type: 'invalid' } });
  }
  assert.equal(asked.length, 3, 'invalid types never reach the server');
});

test('GET whitelist parses the whitelist answer', async (t) => {
  const ctx = await setup(t);
  const res = await ctx.call('GET', `/api/servers/${ctx.id}/whitelist`);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { players: ['Steve', 'Alex'] });
  noTrace(ctx);
});

test('GET gamerules keeps only the rules the server knows, trying the snake_case alt', async (t) => {
  const known = { keepInventory: 'true', do_weather_cycle: 'false' };
  const ctx = await setup(t, {
    handlers: {
      gamerule: (args) =>
        Object.hasOwn(known, args)
          ? `Gamerule ${args} is currently set to: ${known[args]}`
          : UNKNOWN_RULE,
    },
  });
  assert.equal(GAMERULES.find((g) => g.name === 'doWeatherCycle').alt, 'do_weather_cycle');

  const res = await ctx.call('GET', `/api/servers/${ctx.id}/gamerules`);
  assert.equal(res.statusCode, 200, res.body);
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual(res.json().sort(byName), [
    { name: 'do_weather_cycle', type: 'bool', value: 'false' },
    { name: 'keepInventory', type: 'bool', value: 'true' },
  ]);
  noTrace(ctx);
});

test('GET gamerules returns the integer rules with their type', async (t) => {
  const ctx = await setup(t, {
    handlers: {
      gamerule: (args) =>
        args === 'randomTickSpeed' ? 'Gamerule randomTickSpeed is currently set to: 3' : UNKNOWN_RULE,
    },
  });
  const res = await ctx.call('GET', `/api/servers/${ctx.id}/gamerules`);
  assert.deepEqual(res.json(), [{ name: 'randomTickSpeed', type: 'int', value: '3' }]);
});

test('reads answer 502 with the RCON error code when the server is down', async (t) => {
  const ctx = await setup(t);
  await ctx.fake.setOnline(false);
  for (const path of ['players', 'bans', 'whitelist', 'gamerules']) {
    const res = await ctx.call('GET', `/api/servers/${ctx.id}/${path}`);
    assert.equal(res.statusCode, 502, path);
    assert.equal(typeof res.json().error, 'string', path);
    assert.notEqual(res.json().error, 'not_found', path);
  }
  noTrace(ctx);
});

test('reads: 404 for an unknown server, 400 for a bad id, session required', async (t) => {
  const { app, call } = await setup(t);
  for (const path of ['players', 'bans', 'whitelist', 'gamerules']) {
    assert.equal((await call('GET', `/api/servers/999/${path}`)).statusCode, 404, path);
    assert.equal((await call('GET', `/api/servers/abc/${path}`)).statusCode, 400, path);
    const anon = { host: TEST_HOST, origin: TEST_ORIGIN };
    const res = await app.inject({ method: 'GET', url: `/api/servers/1/${path}`, headers: anon });
    assert.equal(res.statusCode, 401, path);
  }
});

test('GAMERULES lists the required rules, each with a snake_case alt', () => {
  const bool = [
    'keepInventory', 'doDaylightCycle', 'doWeatherCycle', 'doMobSpawning', 'mobGriefing', 'doFireTick',
    'naturalRegeneration', 'doInsomnia', 'doImmediateRespawn', 'announceAdvancements', 'showDeathMessages',
    'doEntityDrops', 'doTileDrops', 'fallDamage', 'fireDamage', 'drowningDamage', 'doPatrolSpawning',
    'doTraderSpawning', 'forgiveDeadPlayers', 'universalAnger',
  ];
  const int = ['randomTickSpeed', 'spawnRadius', 'playersSleepingPercentage', 'maxEntityCramming'];
  const byName = new Map(GAMERULES.map((g) => [g.name, g]));
  assert.equal(byName.size, GAMERULES.length, 'names are unique');
  for (const name of bool) assert.equal(byName.get(name)?.type, 'bool', name);
  for (const name of int) assert.equal(byName.get(name)?.type, 'int', name);
  for (const { name, alt, type } of GAMERULES) {
    assert.ok(type === 'bool' || type === 'int', name);
    assert.equal(alt, name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), name);
  }
});
