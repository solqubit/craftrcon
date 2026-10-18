// Pure logic of the Console page: the output log, filtering, export and the
// input history. No DOM, so it can be unit-tested with node:test.
//
// The log is an array of entries:
//   { id?, key, ts, origin, command, ok, output, error, durationMs?, pending }
// `key` (ts|origin|command) identifies one run of a command on the server.
//
// Our own commands reach the page twice: in the HTTP answer to the POST and
// as the live echo every subscriber gets. Each send shows a pending line at
// once; whichever copy arrives first fills it and the other one is dropped
// (the key, or the pending line with the same command, gives it away). The
// HTTP answer also brings the duration.
import { RCON_ERRORS } from './servers.js';
import { stripCodes } from './mctext.js';

export const MAX_LINES = 1000;
const MAX_COMMAND_BYTES = 1446; // vanilla RCON's payload limit, as the API checks
const COMMAND_ERRORS = ['empty', 'invalid_chars', 'too_long', 'not_found'];
const encoder = new TextEncoder();

// Like the API: trimmed, without one leading '/'.
export function normalizeCommand(command) {
  let s = String(command ?? '').trim();
  if (s.startsWith('/')) s = s.slice(1).trim();
  return s;
}

// The API's 400 code for a command it would reject, or null.
export function commandProblem(command) {
  const cmd = normalizeCommand(command);
  if (cmd === '') return 'empty';
  if (/[\r\n\0]/.test(cmd)) return 'invalid_chars';
  if (encoder.encode(cmd).length > MAX_COMMAND_BYTES) return 'too_long';
  return null;
}

// Translation key for an entry's `error`: an API code, an RCON code or a
// network failure.
export function errorKey(code) {
  if (code === 'network_error') return 'errors.network';
  if (COMMAND_ERRORS.includes(code) || RCON_ERRORS.includes(code)) return `console.errors.${code}`;
  return 'console.errors.failed';
}

const keyOf = (ts, origin, command) => `${ts}|${origin}|${command}`;

export function addPending(entries, { id, command, ts }) {
  return [...entries, { id, key: null, ts, origin: 'console', command, ok: true, output: '', error: null, pending: true }];
}

function settled(base, { ts, origin, command, ok, output, error }) {
  return { ...base, key: keyOf(ts, origin, command), ts, origin, command, ok, output: output ?? '', error: error ?? null, pending: false };
}

// The HTTP answer to send #id of `command`: { ok, output, error, durationMs, ts }.
export function resolveSent(entries, id, command, result) {
  const run = { ...result, origin: 'console', command };
  const key = keyOf(result.ts, 'console', command);
  const echoed = entries.findIndex((e) => e.key === key);
  if (echoed >= 0) {
    // The live echo got here first: keep that line, add the duration and drop
    // the pending one if the echo landed elsewhere.
    return entries
      .filter((e) => !(e.id === id && e.pending))
      .map((e) => (e.key === key ? { ...e, durationMs: result.durationMs } : e));
  }
  const index = entries.findIndex((e) => e.id === id);
  const line = settled({ id, durationMs: result.durationMs }, run);
  if (index < 0) return [...entries, line]; // the view was cleared meanwhile
  return entries.map((e, i) => (i === index ? line : e));
}

// Send #id failed before the server ran it (network, 400, 404).
export function failSent(entries, id, code) {
  return entries.map((e) => (e.id === id && e.pending ? { ...e, ok: false, error: code, pending: false } : e));
}

// A { type: 'console' } live message's entry.
export function addLive(entries, entry) {
  const key = keyOf(entry.ts, entry.origin, entry.command);
  if (entries.some((e) => e.key === key)) return entries;
  if (entry.origin === 'console') {
    const index = entries.findIndex((e) => e.pending && e.command === entry.command);
    if (index >= 0) return entries.map((e, i) => (i === index ? settled(e, entry) : e));
  }
  return [...entries, settled({}, entry)];
}

export const splitOutput = (output) => String(output ?? '').replace(/\n+$/, '').split('\n');

// Lines an entry draws below its command line.
export function outputLines(entry) {
  if (entry.pending) return 0;
  if (!entry.ok) return 1;
  return entry.output ? splitOutput(entry.output).length : 0;
}

// Drops the oldest entries until at most `max` lines remain (the newest entry
// always stays, however long it is).
export function trimToLines(entries, max = MAX_LINES) {
  let lines = 0;
  let start = entries.length;
  while (start > 0) {
    const next = lines + 1 + outputLines(entries[start - 1]);
    if (next > max && start < entries.length) break;
    lines = next;
    start--;
  }
  return start === 0 ? entries : entries.slice(start);
}

// Vanilla answers errors as plain text; these openings mark the usual ones.
const ERROR_OUTPUT =
  /^(Unknown or incomplete command|Unknown (item|block|entity|effect|enchantment|function|advancement|recipe|objective|team|biome|structure|dimension|sound|particle|attribute|bossbar|criterion)|Incorrect argument|Invalid |Expected |No (player|entity|targets?|entities) (was |were )?found|Could not |Can't |Cannot |That player does not exist|Only one (player|entity))/i;

export function isErrorOutput(output) {
  return ERROR_OUTPUT.test(stripCodes(output ?? '').trim());
}

// Case-insensitive search in the command and the output (without color codes).
export function matchesFilter(entry, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return true;
  const haystack = `${entry.command}\n${stripCodes(entry.output ?? '')}`.toLowerCase();
  return haystack.includes(q);
}

const pad = (n, size = 2) => String(n).padStart(size, '0');

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const formatDateTime = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(ts)}`;
};

// "Mi Servidor Ñandú #1" -> "mi-servidor-nandu-1".
function slugify(name) {
  const slug = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'server';
}

// craftrcon-<server-name-slug>-<YYYYMMDD-HHmm>.txt, in local time.
export function exportFilename(serverName, date = new Date()) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `craftrcon-${slugify(serverName)}-${stamp}.txt`;
}

// Plain text, one "[YYYY-MM-DD HH:MM:SS] ..." line per visible line; color
// codes removed. `errorText(entry)` words a failed entry's error.
export function formatExport(entries, errorText) {
  const lines = [];
  for (const entry of entries) {
    const at = `[${formatDateTime(entry.ts)}]`;
    const from = entry.origin && entry.origin !== 'console' ? ` (${entry.origin})` : '';
    lines.push(`${at} > ${entry.command}${from}`);
    if (entry.pending) continue;
    if (!entry.ok) lines.push(`${at} ${errorText(entry)}`);
    else if (entry.output) for (const line of splitOutput(entry.output)) lines.push(`${at} ${stripCodes(line)}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// GET /history rows (newest first) -> distinct commands, newest use first.
export function uniqueHistory(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const command = typeof row === 'string' ? row : row?.command;
    if (typeof command !== 'string' || seen.has(command)) continue;
    seen.add(command);
    out.push(command);
  }
  return out;
}

// One ↑ ('up') or ↓ ('down') step through `list` (newest first).
// `state` is { index, draft }: index -1 is the text being written (the draft,
// saved when the walk starts). Returns the next { index, draft, value }, or
// null when there is nowhere to go.
export function walkHistory(state, list, direction, current) {
  const draft = state.index === -1 ? current : state.draft;
  const index = direction === 'up' ? state.index + 1 : state.index - 1;
  if (index < -1 || index >= list.length) return null;
  return { index, draft, value: index === -1 ? draft : list[index] };
}
