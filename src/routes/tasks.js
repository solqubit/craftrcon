import { validateCommand } from '../minecraft/validate.js';
import {
  MAX_INTERVAL_MINUTES,
  MAX_NAME,
  MAX_STEPS,
  MAX_WAIT_MINUTES,
  MIN_INTERVAL_MINUTES,
} from '../services/scheduler.js';
import { notFound, parseId, validation } from './servers.js';

const DAILY_TIME = /^(\d{2}):(\d{2})$/;

const bodyOf = (request) =>
  request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};

function validateStep(step) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return { error: 'invalid' };
  if (step.type === 'command') {
    const checked = validateCommand(step.command);
    return checked.ok ? { value: { type: 'command', command: checked.command } } : { error: checked.error };
  }
  if (step.type === 'wait') {
    const ok = Number.isSafeInteger(step.minutes) && step.minutes >= 1 && step.minutes <= MAX_WAIT_MINUTES;
    return ok ? { value: { type: 'wait', minutes: step.minutes } } : { error: 'invalid' };
  }
  return { error: 'invalid' };
}

// Validates task input. `current` (a stored task) is the base of an update:
// absent fields keep their value. Returns { fields, value }.
function validateTask(body, current = null) {
  const fields = {};
  const pick = (key) => (body[key] !== undefined || !current ? body[key] : current[key]);

  const rawName = pick('name');
  const name = typeof rawName === 'string' ? rawName.trim() : null;
  if (name === null) fields.name = 'invalid';
  else if (name === '') fields.name = 'required';
  else if (name.length > MAX_NAME) fields.name = 'too_long';

  const rawEnabled = current || body.enabled !== undefined ? pick('enabled') : true;
  if (typeof rawEnabled !== 'boolean') fields.enabled = 'invalid';

  const triggerType = pick('triggerType');
  let intervalMinutes = null;
  let dailyTime = null;
  if (triggerType === 'interval') {
    intervalMinutes = pick('intervalMinutes');
    const ok =
      Number.isSafeInteger(intervalMinutes) &&
      intervalMinutes >= MIN_INTERVAL_MINUTES &&
      intervalMinutes <= MAX_INTERVAL_MINUTES;
    if (!ok) fields.intervalMinutes = intervalMinutes == null ? 'required' : 'invalid';
  } else if (triggerType === 'daily') {
    dailyTime = pick('dailyTime');
    const match = typeof dailyTime === 'string' ? DAILY_TIME.exec(dailyTime) : null;
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      fields.dailyTime = dailyTime == null ? 'required' : 'invalid';
    }
  } else {
    fields.triggerType = triggerType == null ? 'required' : 'invalid';
  }

  const rawSteps = pick('steps');
  const steps = [];
  if (!Array.isArray(rawSteps)) fields.steps = rawSteps == null ? 'required' : 'invalid';
  else if (rawSteps.length < 1) fields.steps = 'required';
  else if (rawSteps.length > MAX_STEPS) fields.steps = 'too_many';
  else {
    rawSteps.forEach((raw, i) => {
      const { value, error } = validateStep(raw);
      if (error) fields[`steps.${i}`] = error;
      else steps.push(value);
    });
  }

  return { fields, value: { name, enabled: rawEnabled, triggerType, intervalMinutes, dailyTime, steps } };
}

// All routes are private: the global hook in routes/auth.js guards /api/.
export function registerTaskRoutes(app) {
  const scheduler = () => app.services.scheduler;
  const serverExists = (id) => Boolean(app.services.servers.get(id));

  app.get('/api/servers/:id/tasks', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    if (!serverExists(id)) return notFound(reply);
    return scheduler().tasks.list(id);
  });

  app.post('/api/servers/:id/tasks', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    if (!serverExists(id)) return notFound(reply);
    const { fields, value } = validateTask(bodyOf(request));
    if (Object.keys(fields).length > 0) return validation(reply, fields);
    return reply.code(201).send(scheduler().tasks.create(id, value));
  });

  app.put('/api/servers/:id/tasks/:taskId', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const taskId = parseId(request.params.taskId, reply);
    if (taskId === null) return;
    const current = scheduler().tasks.get(id, taskId);
    if (!current) return notFound(reply);
    const { fields, value } = validateTask(bodyOf(request), current);
    if (Object.keys(fields).length > 0) return validation(reply, fields);
    return scheduler().tasks.update(id, taskId, value) ?? notFound(reply);
  });

  app.delete('/api/servers/:id/tasks/:taskId', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const taskId = parseId(request.params.taskId, reply);
    if (taskId === null) return;
    if (!scheduler().tasks.remove(id, taskId)) return notFound(reply);
    return reply.code(204).send();
  });

  app.post('/api/servers/:id/tasks/:taskId/run', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const taskId = parseId(request.params.taskId, reply);
    if (taskId === null) return;
    if (!scheduler().tasks.get(id, taskId)) return notFound(reply);
    if (!scheduler().runNow(taskId)) return reply.code(409).send({ error: 'already_running' });
    return reply.code(202).send({ started: true });
  });
}
