import { DEFAULT_DANGEROUS_COMMANDS } from '../../public/js/data/dangerous.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { SESSION_COOKIE } from './auth.js';
import { validation } from './servers.js';

export const MIN_PASSWORD_LENGTH = 8;
const DANGEROUS_KEY = 'dangerous_commands';
const MAX_DANGEROUS = 50;
const MAX_DANGEROUS_LENGTH = 64;
const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 200;
const DIGITS = /^\d+$/;

// Trims, checks and deduplicates (case-insensitively, first spelling wins) the
// commands of a PUT. Returns { value } or { fields }.
function validateDangerous(body) {
  if (!Array.isArray(body)) return { fields: { commands: 'invalid' } };
  if (body.length > MAX_DANGEROUS) return { fields: { commands: 'too_many' } };
  const fields = {};
  const seen = new Set();
  const value = [];
  body.forEach((raw, i) => {
    const command = typeof raw === 'string' ? raw.trim() : null;
    if (command === null || command === '') fields[`commands.${i}`] = 'invalid';
    else if (command.length > MAX_DANGEROUS_LENGTH) fields[`commands.${i}`] = 'too_long';
    else if (/[\r\n\0]/.test(command)) fields[`commands.${i}`] = 'invalid';
    else if (!seen.has(command.toLowerCase())) {
      seen.add(command.toLowerCase());
      value.push(command);
    }
  });
  return Object.keys(fields).length > 0 ? { fields } : { value };
}

// Positive-integer query param: '' or absent is "not given".
function intParam(raw, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined || raw === '') return { value: undefined };
  if (typeof raw !== 'string' || !DIGITS.test(raw)) return { error: true };
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? { value: n } : { error: true };
}

// All routes are private: the global hook in routes/auth.js guards /api/.
export function registerSettingsRoutes(app) {
  app.post('/api/settings/password', async (request, reply) => {
    const { settings, sessions, audit } = app.services;
    const body = request.body !== null && typeof request.body === 'object' ? request.body : {};
    const fields = {};
    for (const key of ['current', 'next']) {
      if (typeof body[key] !== 'string' || body[key] === '') fields[key] = 'required';
    }
    if (Object.keys(fields).length > 0) return validation(reply, fields);

    const stored = settings.get('admin_password_hash', null);
    if (stored === null || !(await verifyPassword(body.current, stored))) {
      return reply.code(403).send({ error: 'invalid_password' });
    }
    if (body.next.length < MIN_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: 'password_too_short' });
    }

    settings.set('admin_password_hash', await hashPassword(body.next));
    // The auth hook already validated this cookie, so it is the caller's own session.
    sessions.destroyAllExcept(app.parseCookie(request.headers.cookie ?? '')[SESSION_COOKIE]);
    audit.log({ origin: 'auth', action: 'password_change' });
    return reply.code(204).send();
  });

  const storedDangerous = () => {
    const list = app.services.settings.getJson(DANGEROUS_KEY, null);
    return Array.isArray(list) && list.every((c) => typeof c === 'string') ? list : [...DEFAULT_DANGEROUS_COMMANDS];
  };

  app.get('/api/settings/dangerous-commands', async () => storedDangerous());

  app.put('/api/settings/dangerous-commands', async (request, reply) => {
    const { value, fields } = validateDangerous(request.body);
    if (fields) return validation(reply, fields);
    app.services.settings.setJson(DANGEROUS_KEY, value);
    return value;
  });

  app.get('/api/activity', async (request, reply) => {
    const query = request.query ?? {};
    const serverId = intParam(query.serverId);
    const before = intParam(query.before);
    const limit = intParam(query.limit, MAX_ACTIVITY_LIMIT);
    const fields = {};
    if (serverId.error) fields.serverId = 'invalid';
    if (before.error) fields.before = 'invalid';
    if (limit.error) fields.limit = 'invalid';
    if (Object.keys(fields).length > 0) return validation(reply, fields);

    const size = limit.value ?? DEFAULT_ACTIVITY_LIMIT;
    // One extra row tells whether another page exists.
    const rows = app.services.audit.list({ serverId: serverId.value, before: before.value, limit: size + 1 });
    const page = rows.slice(0, size);
    return {
      items: page.map((r) => ({
        id: r.id,
        ts: r.ts,
        serverId: r.server_id,
        serverName: r.server_name,
        origin: r.origin,
        action: r.action,
        detail: r.detail,
        ok: r.ok,
        result: r.result,
      })),
      nextBefore: rows.length > size ? page[page.length - 1].id : null,
    };
  });

  app.get('/api/version', async () => app.services.updateCheck.check());
}
