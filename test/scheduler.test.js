import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TEST_HOST, TEST_ORIGIN } from './helpers.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';
import { computeNextRun } from '../src/services/scheduler.js';

const MIN = 60e3;

// A fake clock plus a sleep that parks until the test releases it.
function fakeTime(start = Date.parse('2026-03-10T12:00:00')) {
  const clock = { ms: start };
  const sleeps = [];
  const waiters = [];
  const sleep = (ms) =>
    new Promise((resolve) => {
      sleeps.push(ms);
      waiters.push(resolve);
      clock.ms += ms;
    });
  const release = () => waiters.shift()();
  return { clock, now: () => clock.ms, sleep, sleeps, release, pending: () => waiters.length };
}

async function setup(t, { time = fakeTime(), fakeOptions = {} } = {}) {
  const fake = await startFakeMinecraft({ password: 'goodpw', ...fakeOptions });
  t.after(() => fake.close());
  const ctx = await makeApp({ schedulerOptions: { now: time.now, sleep: time.sleep } });
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
    password: 'goodpw',
  });
  const id = created.json().id;
  const base = `/api/servers/${id}/tasks`;
  return { ...ctx, fake, headers, call, id, base, time, scheduler: ctx.services.scheduler };
}

const SAY_WAIT_SAY = [
  { type: 'command', command: 'say a' },
  { type: 'wait', minutes: 5 },
  { type: 'command', command: '/say b' },
];

const newTask = (overrides = {}) => ({
  name: 'Announce',
  triggerType: 'interval',
  intervalMinutes: 30,
  steps: SAY_WAIT_SAY,
  ...overrides,
});

const auditRows = (db) => db.prepare('SELECT * FROM audit ORDER BY id').all();

test('computeNextRun daily is the next local occurrence strictly after the start', () => {
  const task = { trigger_type: 'daily', daily_time: '03:00' };
  const before = Date.parse('2026-03-10T02:59:00');
  assert.equal(computeNextRun(task, before), Date.parse('2026-03-10T03:00:00'));
  const at = Date.parse('2026-03-10T03:00:00');
  assert.equal(computeNextRun(task, at), Date.parse('2026-03-11T03:00:00'));
  assert.equal(computeNextRun(task, at + 1), Date.parse('2026-03-11T03:00:00'));
});

test('computeNextRun interval adds the minutes', () => {
  const from = Date.parse('2026-03-10T12:00:00');
  assert.equal(computeNextRun({ trigger_type: 'interval', interval_minutes: 30 }, from), from + 30 * MIN);
});

test('every task route requires a session', async () => {
  const { app } = await makeApp();
  const headers = { host: TEST_HOST, origin: TEST_ORIGIN };
  for (const [method, url] of [
    ['GET', '/api/servers/1/tasks'],
    ['POST', '/api/servers/1/tasks'],
    ['PUT', '/api/servers/1/tasks/1'],
    ['DELETE', '/api/servers/1/tasks/1'],
    ['POST', '/api/servers/1/tasks/1/run'],
  ]) {
    const res = await app.inject({ method, url, headers, payload: method === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test('a task runs its steps in order as origin task and is audited', async (t) => {
  const { call, base, id, fake, db, time, scheduler } = await setup(t);
  const created = await call('POST', base, newTask());
  assert.equal(created.statusCode, 201);
  const task = created.json();
  assert.equal(task.nextRunAt, time.now() + 30 * MIN);
  assert.deepEqual(task.steps, [
    { type: 'command', command: 'say a' },
    { type: 'wait', minutes: 5 },
    { type: 'command', command: 'say b' },
  ]);

  assert.deepEqual(await scheduler.tick(), { started: [] }); // not due yet
  time.clock.ms = task.nextRunAt;
  assert.deepEqual(await scheduler.tick(), { started: [task.id] });

  // Parked on the wait: the first command ran, the second has not.
  while (time.pending() === 0) await new Promise((r) => setImmediate(r));
  assert.deepEqual(fake.received, ['say a']);
  assert.deepEqual(time.sleeps, [5 * MIN]);
  time.release();
  await scheduler.idle();
  assert.deepEqual(fake.received, ['say a', 'say b']);

  const rows = auditRows(db).filter((r) => r.origin === 'task');
  assert.deepEqual(
    rows.map((r) => [r.origin, r.action, r.detail, r.server_id]),
    [
      ['task', 'task_run', 'Announce', id],
      ['task', 'command', 'say a', id],
      ['task', 'command', 'say b', id],
    ],
  );
  const [stored] = (await call('GET', base)).json();
  assert.equal(stored.lastRunAt, task.nextRunAt);
  assert.equal(stored.nextRunAt, time.now() - 5 * MIN + 30 * MIN); // rescheduled when the run started
});

test('a second tick or manual run while the task is running does not duplicate it', async (t) => {
  const { call, base, fake, time, scheduler } = await setup(t);
  const task = (await call('POST', base, newTask({ intervalMinutes: 1 }))).json();
  time.clock.ms = task.nextRunAt;
  assert.deepEqual((await scheduler.tick()).started, [task.id]);
  while (time.pending() === 0) await new Promise((r) => setImmediate(r));

  // Still running (parked on the wait), and its next run is already due again.
  time.clock.ms += 2 * MIN;
  assert.deepEqual((await scheduler.tick()).started, []);
  const run = await call('POST', `${base}/${task.id}/run`);
  assert.equal(run.statusCode, 409);
  assert.deepEqual(run.json(), { error: 'already_running' });

  time.release();
  await scheduler.idle();
  assert.deepEqual(fake.received, ['say a', 'say b']);
});

test('a disabled task never runs and has no next run', async (t) => {
  const { call, base, fake, time, scheduler } = await setup(t);
  const task = (await call('POST', base, newTask({ enabled: false }))).json();
  assert.equal(task.enabled, false);
  assert.equal(task.nextRunAt, null);
  time.clock.ms += 365 * 24 * 60 * MIN;
  assert.deepEqual((await scheduler.tick()).started, []);
  await scheduler.idle();
  assert.deepEqual(fake.received, []);

  // Disabling an enabled task clears its schedule; enabling computes it from now.
  const live = (await call('POST', base, newTask())).json();
  assert.equal(typeof live.nextRunAt, 'number');
  const off = (await call('PUT', `${base}/${live.id}`, { enabled: false })).json();
  assert.equal(off.nextRunAt, null);
  const on = (await call('PUT', `${base}/${live.id}`, { enabled: true })).json();
  assert.equal(on.nextRunAt, time.now() + 30 * MIN);
});

test('a failing command is recorded and the run goes on', async (t) => {
  const { call, base, fake, db, time, scheduler } = await setup(t);
  await call('POST', base, newTask({ steps: [{ type: 'command', command: 'say a' }, { type: 'command', command: 'say b' }] }));
  await fake.setOnline(false);
  time.clock.ms += 31 * MIN;
  await scheduler.tick();
  await scheduler.idle();
  const commands = auditRows(db).filter((r) => r.action === 'command');
  assert.deepEqual(
    commands.map((r) => [r.detail, r.ok, r.result]),
    [
      ['say a', 0, 'ECONNREFUSED'],
      ['say b', 0, 'ECONNREFUSED'],
    ],
  );
});

test('deleting the task mid-run stops it at the next step', async (t) => {
  const { call, base, fake, time, scheduler } = await setup(t);
  const task = (await call('POST', base, newTask())).json();
  assert.equal((await call('POST', `${base}/${task.id}/run`)).statusCode, 202);
  while (time.pending() === 0) await new Promise((r) => setImmediate(r));
  assert.equal((await call('DELETE', `${base}/${task.id}`)).statusCode, 204);
  time.release();
  await scheduler.idle();
  assert.deepEqual(fake.received, ['say a']);
});

test('a manual run keeps a disabled task unscheduled and uses the steps at start', async (t) => {
  const { call, base, fake, time, scheduler } = await setup(t);
  const task = (await call('POST', base, newTask({ enabled: false }))).json();
  assert.equal((await call('POST', `${base}/${task.id}/run`)).statusCode, 202);
  while (time.pending() === 0) await new Promise((r) => setImmediate(r));
  await call('PUT', `${base}/${task.id}`, { steps: [{ type: 'command', command: 'say changed' }] });
  time.release();
  await scheduler.idle();
  assert.deepEqual(fake.received, ['say a', 'say b']);
  const [stored] = (await call('GET', base)).json();
  assert.equal(stored.nextRunAt, null);
  assert.equal(stored.lastRunAt, time.now() - 5 * MIN);
});

test('editing name or steps keeps the schedule; changing the trigger recomputes it', async (t) => {
  const { call, base, time } = await setup(t);
  const task = (await call('POST', base, newTask())).json();
  time.clock.ms += 10 * MIN;
  const renamed = (await call('PUT', `${base}/${task.id}`, { name: 'Renamed' })).json();
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.nextRunAt, task.nextRunAt);
  const retimed = (await call('PUT', `${base}/${task.id}`, { triggerType: 'daily', dailyTime: '03:00' })).json();
  assert.equal(retimed.nextRunAt, computeNextRun({ trigger_type: 'daily', daily_time: '03:00' }, time.now()));
  assert.equal(retimed.intervalMinutes, null);
});

test('task input is validated', async (t) => {
  const { call, base } = await setup(t);
  const bad = async (overrides, fields) => {
    const res = await call('POST', base, newTask(overrides));
    assert.equal(res.statusCode, 400, JSON.stringify(overrides));
    assert.deepEqual(res.json(), { error: 'validation', fields });
  };
  await bad({ triggerType: 'daily', dailyTime: '25:00' }, { dailyTime: 'invalid' });
  await bad({ triggerType: 'daily', dailyTime: '03:60' }, { dailyTime: 'invalid' });
  await bad({ triggerType: 'daily', dailyTime: '3:00' }, { dailyTime: 'invalid' });
  await bad({ triggerType: 'daily', dailyTime: undefined }, { dailyTime: 'required' });
  await bad({ intervalMinutes: 0 }, { intervalMinutes: 'invalid' });
  await bad({ intervalMinutes: 10081 }, { intervalMinutes: 'invalid' });
  await bad({ intervalMinutes: 1.5 }, { intervalMinutes: 'invalid' });
  await bad({ triggerType: 'weekly' }, { triggerType: 'invalid' });
  await bad({ name: '  ' }, { name: 'required' });
  await bad({ name: 'x'.repeat(61) }, { name: 'too_long' });
  await bad({ steps: [] }, { steps: 'required' });
  await bad({ steps: Array.from({ length: 51 }, () => ({ type: 'wait', minutes: 1 })) }, { steps: 'too_many' });
  await bad({ steps: [{ type: 'wait', minutes: 0 }] }, { 'steps.0': 'invalid' });
  await bad({ steps: [{ type: 'wait', minutes: 1441 }] }, { 'steps.0': 'invalid' });
  await bad({ steps: [{ type: 'command', command: 'say a\nstop' }] }, { 'steps.0': 'invalid_chars' });
  await bad({ steps: [{ type: 'command', command: ' ' }, { type: 'nap' }] }, { 'steps.0': 'empty', 'steps.1': 'invalid' });

  const ok = await call('POST', base, newTask({ intervalMinutes: 10080, steps: Array.from({ length: 50 }, () => ({ type: 'wait', minutes: 1440 })) }));
  assert.equal(ok.statusCode, 201);
});

test('task routes answer 404 for unknown servers and tasks, 400 for bad ids', async (t) => {
  const { call, base } = await setup(t);
  assert.equal((await call('GET', '/api/servers/999/tasks')).statusCode, 404);
  assert.equal((await call('POST', '/api/servers/999/tasks', newTask())).statusCode, 404);
  assert.equal((await call('PUT', `${base}/999`, { name: 'x' })).statusCode, 404);
  assert.equal((await call('DELETE', `${base}/999`)).statusCode, 404);
  assert.equal((await call('POST', `${base}/999/run`)).statusCode, 404);
  assert.equal((await call('GET', '/api/servers/abc/tasks')).statusCode, 400);
  assert.equal((await call('PUT', `${base}/abc`, {})).statusCode, 400);
});

test('tasks are scoped to their server and removed with it', async (t) => {
  const { call, base, id, db } = await setup(t);
  const task = (await call('POST', base, newTask())).json();
  const other = (await call('POST', '/api/servers', { name: 'Creative', host: '127.0.0.1', rconPort: 1, password: 'pw' })).json();
  assert.deepEqual((await call('GET', `/api/servers/${other.id}/tasks`)).json(), []);
  assert.equal((await call('DELETE', `/api/servers/${other.id}/tasks/${task.id}`)).statusCode, 404);
  assert.equal((await call('DELETE', `/api/servers/${id}`)).statusCode, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});
