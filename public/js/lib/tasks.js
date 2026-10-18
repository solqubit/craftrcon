// Pure logic of the Tasks page: how triggers and times read, the editor's
// draft (what the form holds while it is being edited), its validation (the
// same limits as the API) and the step list operations. No DOM.
import { getLang, t } from '../i18n.js';
import { commandProblem, normalizeCommand } from './console.js';

// The API's limits (src/services/scheduler.js).
export const MAX_NAME = 60;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 10080;
export const MAX_STEPS = 50;
export const MIN_WAIT_MINUTES = 1;
export const MAX_WAIT_MINUTES = 1440;

const MINUTE_MS = 60_000;

// ---------- Reading times ----------

// "Every 30 min" / "Every 2 h" (when the interval is a whole number of hours)
// / "Daily at 04:00".
export function formatTrigger(task) {
  if (task.triggerType === 'daily') return t('tasks.trigger.daily', { time: task.dailyTime });
  const minutes = task.intervalMinutes;
  if (minutes % 60 === 0) return t('tasks.trigger.everyHours', { n: minutes / 60 });
  return t('tasks.trigger.everyMinutes', { n: minutes });
}

// A span of whole minutes: "12 min", "2 h 5 min", "3 d 4 h".
export function formatDuration(totalMinutes) {
  const minutes = Math.max(1, Math.floor(totalMinutes));
  if (minutes < 60) return t('tasks.unit.min', { n: minutes });
  if (minutes < 1440) {
    const rest = minutes % 60;
    const hours = t('tasks.unit.h', { n: Math.floor(minutes / 60) });
    return rest ? `${hours} ${t('tasks.unit.min', { n: rest })}` : hours;
  }
  const rest = Math.floor((minutes % 1440) / 60);
  const days = t('tasks.unit.d', { n: Math.floor(minutes / 1440) });
  return rest ? `${days} ${t('tasks.unit.h', { n: rest })}` : days;
}

// "in 12 min"; "in less than a minute" when it is due (the scheduler wakes up
// every 15 s, so a run can be a few seconds late). `at` is epoch ms.
export function formatNextRun(at, now) {
  const left = at - now;
  if (left < MINUTE_MS) return t('tasks.when.soon');
  return t('tasks.when.in', { when: formatDuration(Math.ceil(left / MINUTE_MS)) });
}

// "5 min ago", "just now" or "Never" (no run yet).
export function formatLastRun(at, now) {
  if (at === null || at === undefined) return t('tasks.when.never');
  const ago = now - at;
  if (ago < MINUTE_MS) return t('tasks.when.justNow');
  return t('tasks.when.ago', { when: formatDuration(ago / MINUTE_MS) });
}

// The absolute time in the browser's time zone, for a title attribute.
export function formatAbsolute(at) {
  return new Date(at).toLocaleString(getLang(), { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- The editor's draft ----------

let keySeq = 0;
// Steps carry a `key` so the list keeps each row's identity while it is
// reordered. It is never sent to the API.
const nextKey = () => `step-${++keySeq}`;

export function newStep(type) {
  return type === 'wait' ? { key: nextKey(), type: 'wait', minutes: '1' } : { key: nextKey(), type: 'command', command: '' };
}

const stepFromTask = (step) =>
  step.type === 'wait'
    ? { key: nextKey(), type: 'wait', minutes: String(step.minutes) }
    : { key: nextKey(), type: 'command', command: step.command };

export function emptyDraft() {
  return {
    name: '',
    enabled: true,
    triggerType: 'interval',
    intervalMinutes: '60',
    dailyTime: '04:00',
    steps: [newStep('command')],
  };
}

export function draftFromTask(task) {
  return {
    name: task.name,
    enabled: task.enabled,
    triggerType: task.triggerType,
    intervalMinutes: String(task.intervalMinutes ?? 60),
    dailyTime: task.dailyTime ?? '04:00',
    steps: task.steps.map(stepFromTask),
  };
}

// `draft` with the template applied: its name, trigger and steps, in the
// current language.
export function applyTemplate(draft, template) {
  return {
    ...draft,
    name: t(template.nameKey),
    triggerType: template.triggerType,
    intervalMinutes: template.intervalMinutes === undefined ? draft.intervalMinutes : String(template.intervalMinutes),
    dailyTime: template.dailyTime ?? draft.dailyTime,
    steps: template.steps.map((step) => {
      if (step.type === 'wait') return { key: nextKey(), type: 'wait', minutes: String(step.minutes) };
      const command = step.sayKey ? `say ${t(step.sayKey)}` : step.command;
      return { key: nextKey(), type: 'command', command };
    }),
  };
}

// ---------- Validation ----------

// A whole number from `min` to `max` written as digits: the number, or an
// error code ('required' when empty, else 'invalid').
function wholeNumber(raw, min, max) {
  const text = String(raw ?? '').trim();
  if (text === '') return { error: 'required' };
  if (!/^\d{1,9}$/.test(text)) return { error: 'invalid' };
  const value = Number(text);
  return value >= min && value <= max ? { value } : { error: 'invalid' };
}

const DAILY_TIME = /^(\d{2}):(\d{2})$/;

// What the API would answer with 400: { field: code } keyed like its
// `fields` ('name', 'intervalMinutes', 'dailyTime', 'steps', 'steps.<i>').
// Empty when the draft can be sent.
export function validateDraft(draft) {
  const fields = {};

  const name = draft.name.trim();
  if (name === '') fields.name = 'required';
  else if (name.length > MAX_NAME) fields.name = 'too_long';

  if (draft.triggerType === 'interval') {
    const { error } = wholeNumber(draft.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
    if (error) fields.intervalMinutes = error;
  } else {
    const time = DAILY_TIME.exec(String(draft.dailyTime ?? ''));
    if (!time) fields.dailyTime = draft.dailyTime ? 'invalid' : 'required';
    else if (Number(time[1]) > 23 || Number(time[2]) > 59) fields.dailyTime = 'invalid';
  }

  if (draft.steps.length < 1) fields.steps = 'required';
  else if (draft.steps.length > MAX_STEPS) fields.steps = 'too_many';
  else {
    draft.steps.forEach((step, i) => {
      const problem =
        step.type === 'wait'
          ? wholeNumber(step.minutes, MIN_WAIT_MINUTES, MAX_WAIT_MINUTES).error && 'invalid'
          : commandProblem(step.command);
      if (problem) fields[`steps.${i}`] = problem;
    });
  }
  return fields;
}

// The JSON the API takes for a valid draft.
export function draftToBody(draft) {
  const interval = draft.triggerType === 'interval';
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    triggerType: draft.triggerType,
    intervalMinutes: interval ? Number(draft.intervalMinutes) : null,
    dailyTime: interval ? null : draft.dailyTime,
    steps: draft.steps.map((step) =>
      step.type === 'wait'
        ? { type: 'wait', minutes: Number(step.minutes) }
        : { type: 'command', command: normalizeCommand(step.command) },
    ),
  };
}

// Translation key of the message for an error `code` on `field` (client or API).
export function errorKey(field, code) {
  if (field.startsWith('steps.')) {
    return ['empty', 'invalid_chars', 'too_long'].includes(code) ? `tasks.errors.step.${code}` : 'tasks.errors.step.minutes';
  }
  if (field === 'name' && (code === 'required' || code === 'too_long')) return `tasks.errors.name.${code}`;
  if (field === 'steps' && (code === 'required' || code === 'too_many')) return `tasks.errors.steps.${code}`;
  if (field === 'intervalMinutes' || field === 'dailyTime') return `tasks.errors.${field}`;
  return 'tasks.errors.invalid';
}

// ---------- Step list ----------

// `steps` with the one at `index` moved by `delta` (-1 up, +1 down); the same
// array when it can't move.
export function moveStep(steps, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export const removeStep = (steps, index) => steps.filter((_, i) => i !== index);

// `errors` without the per-step ones (their indexes stop meaning anything once
// the list is reordered or shortened).
export function withoutStepErrors(errors) {
  return Object.fromEntries(Object.entries(errors).filter(([field]) => !field.startsWith('steps.')));
}
