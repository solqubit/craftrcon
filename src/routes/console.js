import { validateCommand } from '../minecraft/validate.js';
import { InvalidCommandError, MAX_LABEL } from '../services/commands.js';
import { notFound, parseId, validation } from './servers.js';

// Origins a client may claim; 'task' is reserved for the scheduler.
const CLIENT_ORIGINS = ['console', 'ui'];

const bodyOf = (request) =>
  request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};

// Validates favorite input. `current` (a stored favorite) is the base of an
// update: absent fields keep their value. Returns { fields, value }.
function validateFavorite(body, current = null) {
  const fields = {};
  const value = {};
  const has = (key) => body[key] !== undefined;

  if (!current || has('label')) {
    const label = typeof body.label === 'string' ? body.label.trim() : null;
    if (label === null) fields.label = 'invalid';
    else if (label === '') fields.label = 'required';
    else if (label.length > MAX_LABEL) fields.label = 'too_long';
    else value.label = label;
  } else {
    value.label = current.label;
  }

  if (!current || has('command')) {
    const checked = validateCommand(body.command);
    if (checked.ok) value.command = checked.command;
    else fields.command = checked.error;
  } else {
    value.command = current.command;
  }

  if (has('position')) {
    if (Number.isSafeInteger(body.position) && body.position >= 0) value.position = body.position;
    else fields.position = 'invalid';
  } else {
    value.position = current?.position; // undefined on create: append
  }

  return { fields, value };
}

// All routes are private: the global hook in routes/auth.js guards /api/.
export function registerConsoleRoutes(app) {
  const commands = () => app.services.commands;
  const serverExists = (id) => Boolean(app.services.servers.get(id));

  app.post('/api/servers/:id/command', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const body = bodyOf(request);
    const origin = body.origin ?? 'console';
    if (!CLIENT_ORIGINS.includes(origin)) return validation(reply, { origin: 'invalid' });
    try {
      const { ok, output, error, durationMs, ts } = await commands().run(id, body.command, { origin });
      return { ok, output, error, durationMs, ts };
    } catch (err) {
      if (err instanceof InvalidCommandError) return reply.code(400).send({ error: err.reason });
      if (err?.code === 'NOT_FOUND') return notFound(reply);
      throw err;
    }
  });

  app.get('/api/servers/:id/history', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    if (!serverExists(id)) return notFound(reply);
    return commands().history(id);
  });

  app.get('/api/servers/:id/favorites', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    if (!serverExists(id)) return notFound(reply);
    return commands().favorites.list(id);
  });

  app.post('/api/servers/:id/favorites', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    if (!serverExists(id)) return notFound(reply);
    const { fields, value } = validateFavorite(bodyOf(request));
    if (Object.keys(fields).length > 0) return validation(reply, fields);
    return reply.code(201).send(commands().favorites.create(id, value));
  });

  app.put('/api/servers/:id/favorites/:favId', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const favId = parseId(request.params.favId, reply);
    if (favId === null) return;
    const current = commands().favorites.get(id, favId);
    if (!current) return notFound(reply);
    const { fields, value } = validateFavorite(bodyOf(request), current);
    if (Object.keys(fields).length > 0) return validation(reply, fields);
    return commands().favorites.update(id, favId, value) ?? notFound(reply);
  });

  app.delete('/api/servers/:id/favorites/:favId', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const favId = parseId(request.params.favId, reply);
    if (favId === null) return;
    if (!commands().favorites.remove(id, favId)) return notFound(reply);
    return reply.code(204).send();
  });
}
