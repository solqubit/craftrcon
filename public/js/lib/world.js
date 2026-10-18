// Builders of the commands the World page sends. Pure functions that return the
// command as one string and throw an Error whose message is a code when a value
// can't be sent safely:
//   invalid_time, invalid_weather, invalid_difficulty, unknown_gamerule,
//   invalid_value, invalid_size, invalid_seconds, invalid_coords.

export const TIME_PRESETS = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };
export const WEATHERS = ['clear', 'rain', 'thunder'];
export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

export const MAX_TIME = 24000;
export const MAX_BORDER_SIZE = 59999968;
export const MAX_BORDER_CENTER = 29999984;
const MAX_INT = 2147483647;

const INTEGER = /^\d+$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

function fail(code) {
  throw new Error(code);
}

// A typed value as trimmed text ('' for anything that is not a string/number).
const text = (value) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

export function timeSet(value) {
  const n = text(value);
  if (!INTEGER.test(n) || Number(n) > MAX_TIME) fail('invalid_time');
  return `time set ${Number(n)}`;
}

export function weather(kind) {
  if (!WEATHERS.includes(kind)) fail('invalid_weather');
  return `weather ${kind}`;
}

export function difficulty(level) {
  if (!DIFFICULTIES.includes(level)) fail('invalid_difficulty');
  return `difficulty ${level}`;
}

// `rules` is the list the API returned ([{ name, type, value }]): only a name
// in it can be set, with the name exactly as the server answered it.
export function gamerule(rules, name, value) {
  const rule = Array.isArray(rules) ? rules.find((r) => r.name === name) : undefined;
  if (!rule) fail('unknown_gamerule');
  if (rule.type === 'bool') {
    const v = typeof value === 'boolean' ? String(value) : value;
    if (v !== 'true' && v !== 'false') fail('invalid_value');
    return `gamerule ${rule.name} ${v}`;
  }
  const n = text(value);
  if (!INTEGER.test(n) || Number(n) > MAX_INT) fail('invalid_value');
  return `gamerule ${rule.name} ${Number(n)}`;
}

// `seconds` is optional: empty means "at once".
export function worldBorderSet(size, seconds) {
  const s = text(size);
  if (!NUMBER.test(s) || Number(s) < 1 || Number(s) > MAX_BORDER_SIZE) fail('invalid_size');
  const secs = text(seconds);
  if (secs === '') return `worldborder set ${Number(s)}`;
  if (!INTEGER.test(secs) || Number(secs) > MAX_INT) fail('invalid_seconds');
  return `worldborder set ${Number(s)} ${Number(secs)}`;
}

export function worldBorderCenter(x, z) {
  const coords = [x, z].map(text);
  for (const c of coords) {
    if (!NUMBER.test(c) || Math.abs(Number(c)) > MAX_BORDER_CENTER) fail('invalid_coords');
  }
  return `worldborder center ${Number(coords[0])} ${Number(coords[1])}`;
}

export const saveAll = () => 'save-all';
