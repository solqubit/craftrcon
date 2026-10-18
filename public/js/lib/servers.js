// Pure logic of the server form: defaults, validation, request bodies and the
// mapping from API/RCON error codes to translation keys. No DOM, no imports,
// so it can be unit-tested with node:test.

export const ICONS = ['mountain', 'sparkle', 'sword', 'castle', 'tree', 'fire', 'diamond', 'skull'];
export const COLORS = ['emerald', 'violet', 'amber', 'sky', 'rose', 'slate'];
export const DEFAULT_RCON_PORT = 25575;
export const DEFAULT_GAME_PORT = 25565;

export const MAX_NAME = 32;
export const MAX_HOST = 255;
export const MAX_PASSWORD = 512;

// RconError codes the test route can answer; each has a message in servers.test.error.<code>.
export const RCON_ERRORS = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'AUTH_FAILED', 'CLOSED', 'TIMEOUT'];

// Form values are strings (what the inputs hold); `server` is a saved server or null.
export function initialValues(server = null) {
  return {
    name: server?.name ?? '',
    host: server?.host ?? '',
    rconPort: String(server?.rconPort ?? DEFAULT_RCON_PORT),
    password: '',
    gamePort: String(server?.gamePort ?? DEFAULT_GAME_PORT),
    icon: server?.icon ?? ICONS[0],
    color: server?.color ?? COLORS[0],
  };
}

// '25575' -> 25575; anything that is not a whole port number -> null.
export function parsePort(text) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

// True when the host or RCON port differ from the saved server's (host compared
// case-insensitively, like the API): the saved password may not follow it.
export function targetChanged(values, server) {
  if (!server) return false;
  return values.host.trim().toLowerCase() !== server.host.toLowerCase() || parsePort(values.rconPort) !== server.rconPort;
}

function checkText(errors, field, value, max) {
  const v = value.trim();
  if (v === '') errors[field] = 'required';
  else if (v.length > max) errors[field] = 'too_long';
}

// Client-side checks that mirror the API's: returns { field: code } (empty when valid).
// Codes: required | too_long | invalid.
export function validate(values, server = null) {
  const errors = {};
  checkText(errors, 'name', values.name, MAX_NAME);
  checkText(errors, 'host', values.host, MAX_HOST);
  if (parsePort(values.rconPort) === null) errors.rconPort = 'invalid';
  if (parsePort(values.gamePort) === null) errors.gamePort = 'invalid';
  if (values.password.length > MAX_PASSWORD) errors.password = 'too_long';
  else if (values.password === '' && (!server || targetChanged(values, server))) errors.password = 'required';
  return errors;
}

// Body for POST /api/servers and PUT /api/servers/:id. An empty password is
// left out, which on update means "keep the saved one".
export function buildPayload(values) {
  const body = {
    name: values.name.trim(),
    host: values.host.trim(),
    rconPort: parsePort(values.rconPort),
    gamePort: parsePort(values.gamePort),
    icon: values.icon,
    color: values.color,
  };
  if (values.password !== '') body.password = values.password;
  return body;
}

// Body for POST /api/servers/test; `id` makes an empty password mean "the saved one".
export function buildTestPayload(values, server = null) {
  const body = { host: values.host.trim(), rconPort: parsePort(values.rconPort) };
  if (values.password !== '') body.password = values.password;
  if (server) body.id = server.id;
  return body;
}

// Only the fields the test needs; same codes as validate().
export function validateForTest(values, server = null) {
  const { host, rconPort, password } = validate(values, server);
  return { ...(host && { host }), ...(rconPort && { rconPort }), ...(password && { password }) };
}

// Translation key for a field error. The password has its own "required" text
// on edit: the saved one is only kept while the host and port stay the same.
export function fieldErrorKey(field, code, { editing = false } = {}) {
  if (field === 'password' && code === 'required') {
    return editing ? 'servers.errors.passwordRetype' : 'servers.errors.required';
  }
  return ['required', 'too_long', 'invalid'].includes(code) ? `servers.errors.${code}` : 'servers.errors.invalid';
}

// Translation key for the outcome of a connection test.
export function testResultKey(result) {
  if (result?.ok) return 'servers.test.ok';
  return RCON_ERRORS.includes(result?.error) ? `servers.test.error.${result.error}` : 'servers.test.error.CLOSED';
}
