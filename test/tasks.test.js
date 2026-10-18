import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASK_TEMPLATES } from '../public/js/data/taskTemplates.js';

// The real locale files, served the way the browser fetches them.
globalThis.fetch = async (url) => {
  const code = /^\/locales\/(\w+)\.json$/.exec(url)[1];
  const body = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));
  return { ok: true, status: 200, json: async () => body };
};

let i18n;
let tasks;
before(async () => {
  i18n = await import('../public/js/i18n.js');
  tasks = await import('../public/js/lib/tasks.js');
  await i18n.setLang('en');
});

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const interval = (intervalMinutes) => ({ triggerType: 'interval', intervalMinutes, dailyTime: null });

// ---------- Reading times ----------

test('formatTrigger: minutes, whole hours and daily', async () => {
  await i18n.setLang('en');
  assert.equal(tasks.formatTrigger(interval(30)), 'Every 30 min');
  assert.equal(tasks.formatTrigger(interval(90)), 'Every 90 min');
  assert.equal(tasks.formatTrigger(interval(120)), 'Every 2 h');
  assert.equal(tasks.formatTrigger(interval(60)), 'Every 1 h');
  assert.equal(tasks.formatTrigger({ triggerType: 'daily', intervalMinutes: null, dailyTime: '04:00' }), 'Daily at 04:00');
});

test('formatTrigger speaks Spanish', async () => {
  await i18n.setLang('es');
  assert.equal(tasks.formatTrigger(interval(30)), 'Cada 30 min');
  assert.equal(tasks.formatTrigger(interval(120)), 'Cada 2 h');
  assert.equal(tasks.formatTrigger({ triggerType: 'daily', dailyTime: '04:00' }), 'Todos los días a las 04:00');
  await i18n.setLang('en');
});

test('formatDuration: minutes, hours and days', async () => {
  await i18n.setLang('en');
  assert.equal(tasks.formatDuration(12), '12 min');
  assert.equal(tasks.formatDuration(0.2), '1 min');
  assert.equal(tasks.formatDuration(60), '1 h');
  assert.equal(tasks.formatDuration(125), '2 h 5 min');
  assert.equal(tasks.formatDuration(1440), '1 d');
  assert.equal(tasks.formatDuration(1440 + 4 * 60 + 30), '1 d 4 h');
});

test('formatNextRun: relative, rounding up, and due', async () => {
  await i18n.setLang('en');
  assert.equal(tasks.formatNextRun(NOW + 12 * MIN, NOW), 'in 12 min');
  assert.equal(tasks.formatNextRun(NOW + 11 * MIN + 1000, NOW), 'in 12 min');
  assert.equal(tasks.formatNextRun(NOW + 125 * MIN, NOW), 'in 2 h 5 min');
  assert.equal(tasks.formatNextRun(NOW + 30_000, NOW), 'in less than a minute');
  assert.equal(tasks.formatNextRun(NOW - 5000, NOW), 'in less than a minute');
  await i18n.setLang('es');
  assert.equal(tasks.formatNextRun(NOW + 12 * MIN, NOW), 'en 12 min');
  await i18n.setLang('en');
});

test('formatLastRun: ago, just now and never', async () => {
  await i18n.setLang('en');
  assert.equal(tasks.formatLastRun(NOW - 5 * MIN - 10_000, NOW), '5 min ago');
  assert.equal(tasks.formatLastRun(NOW - 10_000, NOW), 'just now');
  assert.equal(tasks.formatLastRun(null, NOW), 'Never');
  await i18n.setLang('es');
  assert.equal(tasks.formatLastRun(NOW - 5 * MIN, NOW), 'hace 5 min');
  assert.equal(tasks.formatLastRun(null, NOW), 'Nunca');
  await i18n.setLang('en');
});

test('formatAbsolute returns a readable local date and time', () => {
  assert.match(tasks.formatAbsolute(NOW), /2026/);
});

// ---------- Templates ----------

test('the templates are the three from the spec', () => {
  assert.deepEqual(
    TASK_TEMPLATES.map((x) => x.id),
    ['saveEvery30', 'autoMessage', 'restartWarning'],
  );
  const [save, message, restart] = TASK_TEMPLATES;
  assert.deepEqual([save.triggerType, save.intervalMinutes, save.steps], ['interval', 30, [{ type: 'command', command: 'save-all' }]]);
  assert.deepEqual([message.triggerType, message.intervalMinutes, message.steps.length], ['interval', 60, 1]);
  assert.equal(restart.triggerType, 'daily');
  assert.equal(restart.dailyTime, '04:00');
  assert.deepEqual(
    restart.steps.map((s) => (s.type === 'wait' ? `wait ${s.minutes}` : (s.command ?? 'say'))),
    ['say', 'wait 5', 'say', 'wait 4', 'say', 'wait 1', 'save-all', 'stop'],
  );
});

test('applying a template uses the current language for names and say texts', async () => {
  const restart = TASK_TEMPLATES.find((x) => x.id === 'restartWarning');

  await i18n.setLang('en');
  const en = tasks.applyTemplate(tasks.emptyDraft(), restart);
  assert.equal(en.name, 'Daily restart with warnings');
  assert.equal(en.triggerType, 'daily');
  assert.equal(en.dailyTime, '04:00');
  assert.deepEqual(
    en.steps.map(({ key, ...step }) => step),
    [
      { type: 'command', command: 'say Server restart in 10 minutes' },
      { type: 'wait', minutes: '5' },
      { type: 'command', command: 'say Server restart in 5 minutes' },
      { type: 'wait', minutes: '4' },
      { type: 'command', command: 'say Server restart in 1 minute' },
      { type: 'wait', minutes: '1' },
      { type: 'command', command: 'save-all' },
      { type: 'command', command: 'stop' },
    ],
  );

  await i18n.setLang('es');
  const es = tasks.applyTemplate(tasks.emptyDraft(), restart);
  assert.equal(es.name, 'Reinicio diario con avisos');
  assert.equal(es.steps[0].command, 'say Reinicio del servidor en 10 minutos');
  await i18n.setLang('en');
});

test('every template makes a draft the API would accept', async () => {
  for (const lang of ['en', 'es']) {
    await i18n.setLang(lang);
    for (const template of TASK_TEMPLATES) {
      const draft = tasks.applyTemplate(tasks.emptyDraft(), template);
      assert.deepEqual(tasks.validateDraft(draft), {}, `${template.id} in ${lang}`);
    }
  }
  await i18n.setLang('en');
});

test('applying an interval template keeps the daily time, and vice versa', () => {
  const draft = { ...tasks.emptyDraft(), dailyTime: '09:30', intervalMinutes: '15' };
  const save = tasks.applyTemplate(draft, TASK_TEMPLATES[0]);
  assert.equal(save.dailyTime, '09:30');
  assert.equal(save.intervalMinutes, '30');
  const restart = tasks.applyTemplate(draft, TASK_TEMPLATES[2]);
  assert.equal(restart.intervalMinutes, '15');
});

// ---------- Draft and validation ----------

const draftWith = (patch) => ({ ...tasks.emptyDraft(), name: 'Task', steps: [{ key: 'a', type: 'command', command: 'save-all' }], ...patch });

test('a fresh draft needs a name and a command', () => {
  assert.deepEqual(tasks.validateDraft(tasks.emptyDraft()), { name: 'required', 'steps.0': 'empty' });
});

test('validateDraft: name', () => {
  assert.equal(tasks.validateDraft(draftWith({ name: '   ' })).name, 'required');
  assert.equal(tasks.validateDraft(draftWith({ name: 'x'.repeat(61) })).name, 'too_long');
  assert.equal(tasks.validateDraft(draftWith({ name: 'x'.repeat(60) })).name, undefined);
});

test('validateDraft: interval limits', () => {
  const code = (value) => tasks.validateDraft(draftWith({ triggerType: 'interval', intervalMinutes: value })).intervalMinutes;
  assert.equal(code('1'), undefined);
  assert.equal(code('10080'), undefined);
  assert.equal(code('0'), 'invalid');
  assert.equal(code('10081'), 'invalid');
  assert.equal(code('1.5'), 'invalid');
  assert.equal(code('-3'), 'invalid');
  assert.equal(code('abc'), 'invalid');
  assert.equal(code(''), 'required');
});

test('validateDraft: daily time', () => {
  const code = (value) => tasks.validateDraft(draftWith({ triggerType: 'daily', dailyTime: value })).dailyTime;
  assert.equal(code('00:00'), undefined);
  assert.equal(code('23:59'), undefined);
  assert.equal(code('24:00'), 'invalid');
  assert.equal(code('12:60'), 'invalid');
  assert.equal(code('4:00'), 'invalid');
  assert.equal(code(''), 'required');
});

test('validateDraft ignores the fields of the other trigger', () => {
  assert.deepEqual(tasks.validateDraft(draftWith({ triggerType: 'daily', intervalMinutes: 'nope' })), {});
  assert.deepEqual(tasks.validateDraft(draftWith({ triggerType: 'interval', dailyTime: 'nope' })), {});
});

test('validateDraft: step count', () => {
  assert.equal(tasks.validateDraft(draftWith({ steps: [] })).steps, 'required');
  const many = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, type: 'command', command: 'list' }));
  assert.equal(tasks.validateDraft(draftWith({ steps: many })).steps, 'too_many');
  assert.deepEqual(tasks.validateDraft(draftWith({ steps: many.slice(0, 50) })), {});
});

test('validateDraft keys step errors by index, with the API codes', () => {
  const steps = [
    { key: 'a', type: 'command', command: 'list' },
    { key: 'b', type: 'command', command: '   ' },
    { key: 'c', type: 'command', command: 'say a\nb' },
    { key: 'd', type: 'command', command: `say ${'é'.repeat(800)}` },
    { key: 'e', type: 'wait', minutes: '0' },
    { key: 'f', type: 'wait', minutes: '1441' },
    { key: 'g', type: 'wait', minutes: '2.5' },
    { key: 'h', type: 'wait', minutes: '' },
    { key: 'i', type: 'wait', minutes: '1440' },
  ];
  assert.deepEqual(tasks.validateDraft(draftWith({ steps })), {
    'steps.1': 'empty',
    'steps.2': 'invalid_chars',
    'steps.3': 'too_long',
    'steps.4': 'invalid',
    'steps.5': 'invalid',
    'steps.6': 'invalid',
    'steps.7': 'invalid',
  });
});

test('draftToBody builds the API payload without keys or typing leftovers', () => {
  const draft = draftWith({
    name: '  Save  ',
    intervalMinutes: '30',
    steps: [
      { key: 'a', type: 'command', command: ' /save-all ' },
      { key: 'b', type: 'wait', minutes: '5' },
    ],
  });
  assert.deepEqual(tasks.draftToBody(draft), {
    name: 'Save',
    enabled: true,
    triggerType: 'interval',
    intervalMinutes: 30,
    dailyTime: null,
    steps: [
      { type: 'command', command: 'save-all' },
      { type: 'wait', minutes: 5 },
    ],
  });
  const daily = tasks.draftToBody({ ...draft, triggerType: 'daily', dailyTime: '04:00' });
  assert.equal(daily.intervalMinutes, null);
  assert.equal(daily.dailyTime, '04:00');
});

test('draftFromTask and draftToBody round-trip a task', () => {
  const task = {
    id: 7,
    serverId: 1,
    name: 'Restart',
    enabled: false,
    triggerType: 'daily',
    intervalMinutes: null,
    dailyTime: '04:00',
    steps: [
      { type: 'command', command: 'say Bye' },
      { type: 'wait', minutes: 5 },
      { type: 'command', command: 'stop' },
    ],
    lastRunAt: null,
    nextRunAt: null,
  };
  const draft = tasks.draftFromTask(task);
  assert.equal(new Set(draft.steps.map((s) => s.key)).size, 3);
  assert.deepEqual(tasks.draftToBody(draft), {
    name: 'Restart',
    enabled: false,
    triggerType: 'daily',
    intervalMinutes: null,
    dailyTime: '04:00',
    steps: task.steps,
  });
});

test('newStep makes a blank command or a 1-minute wait with unique keys', () => {
  const a = tasks.newStep('command');
  const b = tasks.newStep('wait');
  assert.deepEqual([a.type, a.command], ['command', '']);
  assert.deepEqual([b.type, b.minutes], ['wait', '1']);
  assert.notEqual(a.key, b.key);
});

// ---------- Error messages ----------

test('errorKey maps API and client codes to messages that exist in both languages', async () => {
  const cases = [
    ['name', 'required'], ['name', 'too_long'], ['name', 'invalid'],
    ['intervalMinutes', 'required'], ['intervalMinutes', 'invalid'],
    ['dailyTime', 'invalid'], ['triggerType', 'invalid'],
    ['steps', 'required'], ['steps', 'too_many'],
    ['steps.2', 'empty'], ['steps.2', 'invalid_chars'], ['steps.2', 'too_long'], ['steps.2', 'invalid'],
  ];
  for (const lang of ['en', 'es']) {
    await i18n.setLang(lang);
    for (const [field, code] of cases) {
      const key = tasks.errorKey(field, code);
      assert.notEqual(i18n.t(key), key, `${field}/${code} in ${lang}`);
    }
  }
  assert.equal(tasks.errorKey('steps.0', 'invalid'), 'tasks.errors.step.minutes');
  await i18n.setLang('en');
});

// ---------- Step list ----------

test('moveStep swaps neighbours and ignores moves off the ends', () => {
  const steps = ['a', 'b', 'c'].map((key) => ({ key }));
  assert.deepEqual(tasks.moveStep(steps, 1, -1).map((s) => s.key), ['b', 'a', 'c']);
  assert.deepEqual(tasks.moveStep(steps, 1, 1).map((s) => s.key), ['a', 'c', 'b']);
  assert.equal(tasks.moveStep(steps, 0, -1), steps);
  assert.equal(tasks.moveStep(steps, 2, 1), steps);
  assert.deepEqual(steps.map((s) => s.key), ['a', 'b', 'c']);
});

test('removeStep and withoutStepErrors', () => {
  const steps = ['a', 'b', 'c'].map((key) => ({ key }));
  assert.deepEqual(tasks.removeStep(steps, 1).map((s) => s.key), ['a', 'c']);
  assert.deepEqual(tasks.withoutStepErrors({ name: 'required', 'steps.0': 'empty', steps: 'required', 'steps.12': 'invalid' }), {
    name: 'required',
    steps: 'required',
  });
});
