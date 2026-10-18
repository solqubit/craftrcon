// Pure logic of the Settings page: password form checks, the dangerous-commands
// editor and the activity list. Pure ES module (unit-tested).

export const MIN_PASSWORD_LENGTH = 8; // the API counts JS string length, so does this
export const MAX_DANGEROUS_COMMANDS = 50;
export const MAX_DANGEROUS_LENGTH = 64;
export const RESULT_PREVIEW_CHARS = 80;
// Ruling R15: the user downloads the project anywhere and runs update.sh from that copy.
export const UPDATE_COMMAND = 'git clone https://github.com/solqubit/craftrcon.git && cd craftrcon && sudo ./update.sh';

// Field errors of the password form: { current?, next?, repeat? } with the
// codes 'required' | 'too_short' | 'mismatch'. Empty object: good to send.
export function checkPasswordForm({ current, next, repeat }) {
  const errors = {};
  if (current === '') errors.current = 'required';
  if (next === '') errors.next = 'required';
  else if (next.length < MIN_PASSWORD_LENGTH) errors.next = 'too_short';
  if (repeat === '') errors.repeat = 'required';
  else if (next !== repeat) errors.repeat = 'mismatch';
  return errors;
}

// Adds `raw` to the list of dangerous commands the way the API will keep it:
// trimmed, duplicates (any case) refused. Returns { list } or { error } with
// 'empty' | 'too_long' | 'invalid' | 'duplicate' | 'too_many'.
export function addCommand(list, raw) {
  const command = String(raw ?? '').trim();
  if (command === '') return { error: 'empty' };
  if (/[\r\n\0]/.test(command)) return { error: 'invalid' };
  if (command.length > MAX_DANGEROUS_LENGTH) return { error: 'too_long' };
  if (list.some((c) => c.toLowerCase() === command.toLowerCase())) return { error: 'duplicate' };
  if (list.length >= MAX_DANGEROUS_COMMANDS) return { error: 'too_many' };
  return { list: [...list, command] };
}

export function sameList(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// The first line of `text`, cut at `max` characters; `cut` says whether anything
// was left out, so the page can offer the full text.
export function preview(text, max = RESULT_PREVIEW_CHARS) {
  const value = String(text ?? '');
  const firstLine = value.split(/\r?\n/, 1)[0];
  const shown = firstLine.length > max ? `${firstLine.slice(0, max).trimEnd()}…` : firstLine;
  return { text: shown, cut: shown !== value };
}

// Appends the next page, skipping rows already on screen (an id never repeats).
export function appendPage(items, page) {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.filter((item) => !seen.has(item.id))];
}

export const ACTIVITY_ACTIONS = ['command', 'login_ok', 'login_fail', 'password_change', 'server_create', 'server_update', 'server_delete', 'task_run'];
export const ACTIVITY_ORIGINS = ['console', 'ui', 'task', 'auth', 'system'];

// Translation key of an action / origin, or null when this panel version does
// not know it (the page then shows the raw value).
export const actionKey = (action) => (ACTIVITY_ACTIONS.includes(action) ? `settings.activity.actions.${action}` : null);
export const originKey = (origin) => (ACTIVITY_ORIGINS.includes(origin) ? `settings.activity.origins.${origin}` : null);

// Seconds to wait from a 429 answer's retryAfterMs (at least 1).
export const retrySeconds = (retryAfterMs) => Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000));
