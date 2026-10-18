export const MAX_NAME = 60;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 10080;
export const MAX_STEPS = 50;
export const MAX_WAIT_MINUTES = 1440;
export const DEFAULT_TICK_MS = 15_000;

const MINUTE_MS = 60e3;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Next run of a task row ({ trigger_type, interval_minutes, daily_time }),
// strictly after `fromMs`. 'daily' uses the process's local time; when a DST
// gap swallows the wall time, the instant JS resolves it to is used.
export function computeNextRun(task, fromMs) {
  if (task.trigger_type === 'interval') return fromMs + task.interval_minutes * MINUTE_MS;
  const [hours, minutes] = task.daily_time.split(':').map(Number);
  const date = new Date(fromMs);
  date.setHours(hours, minutes, 0, 0);
  while (date.getTime() <= fromMs) {
    date.setDate(date.getDate() + 1);
    date.setHours(hours, minutes, 0, 0);
  }
  return date.getTime();
}

function toPublic(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    enabled: row.enabled === 1,
    triggerType: row.trigger_type,
    intervalMinutes: row.interval_minutes,
    dailyTime: row.daily_time,
    steps: JSON.parse(row.steps),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

const rowShape = (input) => ({
  trigger_type: input.triggerType,
  interval_minutes: input.intervalMinutes,
  daily_time: input.dailyTime,
});

// Scheduled tasks: storage plus the runner. Task values passed to create() and
// update() must already be validated (see routes/tasks.js).
//
// tick() resolves once the due runs have STARTED, with { started: [taskId] };
// idle() resolves when every run in flight has finished (for tests/shutdown).
export function createScheduler({
  db,
  commands,
  audit,
  now = Date.now,
  sleep = defaultSleep,
  tickMs = DEFAULT_TICK_MS,
  log = null,
}) {
  const COLUMNS =
    'id, server_id, name, enabled, trigger_type, interval_minutes, daily_time, steps, last_run_at, next_run_at';
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE server_id = ? ORDER BY id`);
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE server_id = ? AND id = ?`);
  const selectById = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`);
  const selectDue = db.prepare(
    `SELECT ${COLUMNS} FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`,
  );
  const insert = db.prepare(
    `INSERT INTO tasks (server_id, name, enabled, trigger_type, interval_minutes, daily_time, steps, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRow = db.prepare(
    `UPDATE tasks SET name = ?, enabled = ?, trigger_type = ?, interval_minutes = ?, daily_time = ?, steps = ?, next_run_at = ?
     WHERE server_id = ? AND id = ?`,
  );
  const deleteRow = db.prepare('DELETE FROM tasks WHERE server_id = ? AND id = ?');
  const markStarted = db.prepare('UPDATE tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?');

  const list = (serverId) => selectAll.all(serverId).map(toPublic);
  const get = (serverId, id) => {
    const row = selectOne.get(serverId, id);
    return row ? toPublic(row) : null;
  };

  function create(serverId, input) {
    const next = input.enabled ? computeNextRun(rowShape(input), now()) : null;
    const { lastInsertRowid } = insert.run(
      serverId,
      input.name,
      input.enabled ? 1 : 0,
      input.triggerType,
      input.intervalMinutes,
      input.dailyTime,
      JSON.stringify(input.steps),
      next,
    );
    return get(serverId, Number(lastInsertRowid));
  }

  // `input` is a full validated task (current values merged in). The next run
  // is recomputed only when the task gets enabled or its trigger changes;
  // disabling clears it.
  function update(serverId, id, input) {
    const current = selectOne.get(serverId, id);
    if (!current) return null;
    const triggerChanged =
      current.trigger_type !== input.triggerType ||
      current.interval_minutes !== input.intervalMinutes ||
      current.daily_time !== input.dailyTime;
    let next = null;
    if (input.enabled) {
      const reschedule = current.enabled !== 1 || triggerChanged || current.next_run_at === null;
      next = reschedule ? computeNextRun(rowShape(input), now()) : current.next_run_at;
    }
    updateRow.run(
      input.name,
      input.enabled ? 1 : 0,
      input.triggerType,
      input.intervalMinutes,
      input.dailyTime,
      JSON.stringify(input.steps),
      next,
      serverId,
      id,
    );
    return get(serverId, id);
  }

  const remove = (serverId, id) => Number(deleteRow.run(serverId, id).changes) > 0;

  const running = new Map(); // task id -> promise of the run in flight
  let stopped = false;

  // Whether the run may go on: the task (hence its server) still exists.
  const alive = (taskId) => !stopped && selectById.get(taskId) !== undefined;

  async function execute(task, steps) {
    for (const step of steps) {
      if (!alive(task.id)) return;
      if (step.type === 'wait') {
        await sleep(step.minutes * MINUTE_MS);
        continue;
      }
      try {
        // Failures are audited by commands.run itself and do not stop the run.
        await commands.run(task.server_id, step.command, { origin: 'task' });
      } catch (err) {
        if (err?.code === 'NOT_FOUND') return; // server gone
        if (err?.code !== 'INVALID_COMMAND') throw err;
        audit.log({
          serverId: task.server_id,
          origin: 'task',
          action: 'command',
          detail: String(step.command),
          ok: false,
          result: err.reason,
        });
      }
    }
  }

  // Starts a run of the task row unless one is in flight; the run itself is
  // not awaited. Steps are snapshotted here.
  function startRun(task) {
    if (running.has(task.id)) return false;
    const ts = now();
    // A disabled task keeps no schedule, even when run by hand.
    markStarted.run(ts, task.enabled === 1 ? computeNextRun(task, ts) : null, task.id);
    audit.log({ serverId: task.server_id, origin: 'task', action: 'task_run', detail: task.name });
    const run = execute(task, JSON.parse(task.steps))
      .catch((err) => log?.error({ err, taskId: task.id }, 'scheduled task run failed'))
      .finally(() => running.delete(task.id));
    running.set(task.id, run);
    return true;
  }

  async function tick() {
    const started = [];
    for (const task of selectDue.all(now())) {
      if (startRun(task)) started.push(task.id);
    }
    return { started };
  }

  // Manual run. false: the task is unknown or already running.
  function runNow(taskId) {
    const task = selectById.get(taskId);
    return task ? startRun(task) : false;
  }

  async function idle() {
    while (running.size > 0) await Promise.all(running.values());
  }

  let timer = null;
  function start() {
    stopped = false;
    if (timer) return;
    timer = setInterval(() => tick().catch((err) => log?.error({ err }, 'scheduler tick failed')), tickMs);
    timer.unref();
  }

  // Stops ticking; runs in flight end at their next step.
  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
  }

  return { tasks: { list, get, create, update, remove }, tick, idle, runNow, start, stop };
}
