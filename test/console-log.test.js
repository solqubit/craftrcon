import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LINES,
  addLive,
  addPending,
  commandProblem,
  errorKey,
  exportFilename,
  failSent,
  formatExport,
  formatTime,
  isErrorOutput,
  matchesFilter,
  normalizeCommand,
  outputLines,
  resolveSent,
  trimToLines,
  uniqueHistory,
  walkHistory,
} from '../public/js/lib/console.js';

// A fixed local time keeps the formatting tests independent of the timezone.
const TS = new Date(2026, 9, 17, 9, 5, 7).getTime();

test('normalizeCommand trims and drops one leading slash, like the API', () => {
  assert.equal(normalizeCommand('  /say hi  '), 'say hi');
  assert.equal(normalizeCommand('/ list'), 'list');
  assert.equal(normalizeCommand('//x'), '/x');
  assert.equal(normalizeCommand(undefined), '');
});

test('commandProblem mirrors the API checks', () => {
  assert.equal(commandProblem('list'), null);
  assert.equal(commandProblem(' / '), 'empty');
  assert.equal(commandProblem('say a\nb'), 'invalid_chars');
  assert.equal(commandProblem(`say ${'a'.repeat(1442)}`), null); // 1446 bytes
  assert.equal(commandProblem(`say ${'a'.repeat(1443)}`), 'too_long');
  assert.equal(commandProblem(`say ${'ñ'.repeat(722)}`), 'too_long'); // bytes, not characters
});

test('errorKey translates API, RCON and network failures', () => {
  assert.equal(errorKey('too_long'), 'console.errors.too_long');
  assert.equal(errorKey('AUTH_FAILED'), 'console.errors.AUTH_FAILED');
  assert.equal(errorKey('network_error'), 'errors.network');
  assert.equal(errorKey('not_found'), 'console.errors.not_found');
  assert.equal(errorKey('weird'), 'console.errors.failed');
});

test('a sent command is pending, then filled by its HTTP answer', () => {
  let log = addPending([], { id: 1, command: 'list', ts: TS });
  assert.equal(log[0].pending, true);
  log = resolveSent(log, 1, 'list', { ok: true, output: 'There are 0', error: null, durationMs: 4, ts: TS + 1 });
  assert.deepEqual(log, [
    { id: 1, key: `${TS + 1}|console|list`, ts: TS + 1, origin: 'console', command: 'list', ok: true, output: 'There are 0', error: null, durationMs: 4, pending: false },
  ]);
  // The live echo of the same run is ignored.
  const echo = { ts: TS + 1, origin: 'console', command: 'list', ok: true, output: 'There are 0', error: null };
  assert.equal(addLive(log, echo), log);
});

test('a live echo that arrives first fills the pending line; the HTTP answer adds the duration', () => {
  let log = addPending([], { id: 1, command: 'tps', ts: TS });
  log = addLive(log, { ts: TS + 2, origin: 'console', command: 'tps', ok: true, output: '20', error: null });
  assert.equal(log.length, 1);
  assert.equal(log[0].pending, false);
  assert.equal(log[0].output, '20');
  log = resolveSent(log, 1, 'tps', { ok: true, output: '20', error: null, durationMs: 9, ts: TS + 2 });
  assert.equal(log.length, 1);
  assert.equal(log[0].durationMs, 9);
});

test('live entries from other origins are appended once', () => {
  const entry = { ts: TS, origin: 'task', command: 'save-all', ok: true, output: 'Saved the game', error: null };
  let log = addPending([], { id: 1, command: 'save-all', ts: TS });
  log = addLive(log, entry);
  assert.equal(log.length, 2); // a task is not our pending console command
  assert.equal(log[1].origin, 'task');
  assert.equal(addLive(log, entry), log);
});

test('an answer for a cleared line is appended unless its echo already was', () => {
  const answer = { ok: true, output: 'x', error: null, durationMs: 1, ts: TS };
  assert.equal(resolveSent([], 7, 'seed', answer).length, 1);
  const echoed = addLive([], { ts: TS, origin: 'console', command: 'seed', ok: true, output: 'x', error: null });
  assert.equal(resolveSent(echoed, 7, 'seed', answer).length, 1);
});

test('failSent turns the pending line into an error line', () => {
  const log = failSent(addPending([], { id: 3, command: 'list', ts: TS }), 3, 'network_error');
  assert.equal(log[0].pending, false);
  assert.equal(log[0].ok, false);
  assert.equal(log[0].error, 'network_error');
  assert.deepEqual(failSent([], 3, 'x'), []);
});

test('outputLines counts the lines an entry draws below its command', () => {
  assert.equal(outputLines({ ok: true, output: '' }), 0);
  assert.equal(outputLines({ ok: true, output: 'a\nb\n' }), 2);
  assert.equal(outputLines({ ok: false, output: '', error: 'CLOSED' }), 1);
  assert.equal(outputLines({ pending: true, output: '' }), 0);
});

test(`trimToLines keeps at most ${MAX_LINES} lines, dropping the oldest entries`, () => {
  const entries = Array.from({ length: 600 }, (_, i) => ({ id: i, ok: true, output: 'one line' })); // 2 lines each
  const kept = trimToLines(entries);
  assert.equal(kept.length, 500);
  assert.equal(kept[0].id, 100);
  assert.equal(trimToLines(entries.slice(0, 3)).length, 3);
  const huge = [{ id: 'a', ok: true, output: 'x' }, { id: 'b', ok: true, output: 'x\n'.repeat(2000) }];
  assert.deepEqual(trimToLines(huge).map((e) => e.id), ['b']); // the newest entry always stays
});

test('isErrorOutput spots vanilla error replies', () => {
  assert.equal(isErrorOutput('Unknown or incomplete command, see below for error'), true);
  assert.equal(isErrorOutput("Unknown item 'minecraft:diamond_swrd'"), true);
  assert.equal(isErrorOutput('Incorrect argument for command'), true);
  assert.equal(isErrorOutput('No player was found'), true);
  assert.equal(isErrorOutput('Expected whitespace to end one argument, but found trailing data'), true);
  assert.equal(isErrorOutput('There are 2 of a max of 20 players online: Steve, Alex'), false);
  assert.equal(isErrorOutput(''), false);
});

test('matchesFilter looks at the command and the output without color codes', () => {
  const entry = { command: 'tps', output: '§6TPS from last 1m: §a20.0', ok: true };
  assert.equal(matchesFilter(entry, ''), true);
  assert.equal(matchesFilter(entry, 'TPS'), true);
  assert.equal(matchesFilter(entry, 'from LAST'), true);
  assert.equal(matchesFilter(entry, '§6'), false);
  assert.equal(matchesFilter(entry, 'list'), false);
});

test('formatTime is HH:MM:SS in local time', () => {
  assert.equal(formatTime(TS), '09:05:07');
});

test('exportFilename: craftrcon-<slug>-<YYYYMMDD-HHmm>.txt', () => {
  const at = new Date(2026, 0, 2, 3, 4);
  assert.equal(exportFilename('Survival', at), 'craftrcon-survival-20260102-0304.txt');
  assert.equal(exportFilename('  Mi Servidor Ñandú #1 ', at), 'craftrcon-mi-servidor-nandu-1-20260102-0304.txt');
  assert.equal(exportFilename('★★★', at), 'craftrcon-server-20260102-0304.txt');
});

test('formatExport writes plain text with a timestamp on every line', () => {
  const entries = [
    { ts: TS, origin: 'console', command: 'tps', ok: true, output: '§6TPS: §a20\nline 2', error: null },
    { ts: TS, origin: 'task', command: 'save-all', ok: true, output: '', error: null },
    { ts: TS, origin: 'console', command: 'list', ok: false, output: '', error: 'CLOSED' },
    { ts: TS, origin: 'console', command: 'seed', pending: true, output: '' },
  ];
  const text = formatExport(entries, (e) => `error ${e.error}`);
  assert.equal(
    text,
    [
      '[2026-10-17 09:05:07] > tps',
      '[2026-10-17 09:05:07] TPS: 20',
      '[2026-10-17 09:05:07] line 2',
      '[2026-10-17 09:05:07] > save-all (task)',
      '[2026-10-17 09:05:07] > list',
      '[2026-10-17 09:05:07] error CLOSED',
      '[2026-10-17 09:05:07] > seed',
      '',
    ].join('\n'),
  );
});

test('uniqueHistory keeps the newest use of each command', () => {
  const rows = [{ command: 'list' }, { command: 'tps' }, { command: 'list' }, { command: 'say hi' }];
  assert.deepEqual(uniqueHistory(rows), ['list', 'tps', 'say hi']);
});

test('walkHistory: up goes back in time, down returns to the draft', () => {
  const list = ['c', 'b', 'a']; // newest first
  let s = { index: -1, draft: '' };
  s = walkHistory(s, list, 'up', 'dra');
  assert.deepEqual(s, { index: 0, draft: 'dra', value: 'c' });
  s = walkHistory(s, list, 'up', s.value);
  s = walkHistory(s, list, 'up', s.value);
  assert.equal(s.value, 'a');
  assert.equal(walkHistory(s, list, 'up', s.value), null); // already at the oldest
  s = walkHistory(s, list, 'down', s.value);
  assert.equal(s.value, 'b');
  s = walkHistory(walkHistory(s, list, 'down', s.value), list, 'down', 'c');
  assert.deepEqual(s, { index: -1, draft: 'dra', value: 'dra' });
  assert.equal(walkHistory(s, list, 'down', 'dra'), null); // already at the draft
  assert.equal(walkHistory({ index: -1, draft: '' }, [], 'up', ''), null);
});
