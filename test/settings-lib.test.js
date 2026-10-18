import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DANGEROUS_COMMANDS,
  UPDATE_COMMAND,
  actionKey,
  addCommand,
  appendPage,
  checkPasswordForm,
  originKey,
  preview,
  retrySeconds,
  sameList,
} from '../public/js/lib/settings.js';

test('password form: requires every field', () => {
  assert.deepEqual(checkPasswordForm({ current: '', next: '', repeat: '' }), { current: 'required', next: 'required', repeat: 'required' });
});

test('password form: new password needs 8 characters and must be repeated exactly', () => {
  assert.deepEqual(checkPasswordForm({ current: 'x', next: 'short', repeat: 'short' }), { next: 'too_short' });
  assert.deepEqual(checkPasswordForm({ current: 'x', next: '12345678', repeat: '1234567' }), { repeat: 'mismatch' });
  assert.deepEqual(checkPasswordForm({ current: 'x', next: '12345678', repeat: '12345678' }), {});
});

test('addCommand trims and appends', () => {
  assert.deepEqual(addCommand(['stop'], '  kill @e '), { list: ['stop', 'kill @e'] });
});

test('addCommand refuses empty, duplicate (any case), invalid, long and too many', () => {
  assert.equal(addCommand([], '   ').error, 'empty');
  assert.equal(addCommand(['Stop'], 'stop').error, 'duplicate');
  assert.equal(addCommand([], 'a\nb').error, 'invalid');
  assert.equal(addCommand([], 'x'.repeat(65)).error, 'too_long');
  assert.deepEqual(addCommand([], 'x'.repeat(64)).list, ['x'.repeat(64)]);
  const full = Array.from({ length: MAX_DANGEROUS_COMMANDS }, (_, i) => `c${i}`);
  assert.equal(addCommand(full, 'extra').error, 'too_many');
});

test('sameList compares order and spelling', () => {
  assert.equal(sameList(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameList(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameList(['a'], ['A']), false);
  assert.equal(sameList([], ['a']), false);
});

test('preview keeps the first line, cut at the limit', () => {
  assert.deepEqual(preview('ok'), { text: 'ok', cut: false });
  assert.deepEqual(preview('line1\nline2'), { text: 'line1', cut: true });
  assert.deepEqual(preview('a'.repeat(100), 10), { text: `${'a'.repeat(10)}…`, cut: true });
  assert.deepEqual(preview(null), { text: '', cut: false });
});

test('appendPage skips rows already shown', () => {
  const items = [{ id: 5 }, { id: 4 }];
  assert.deepEqual(appendPage(items, [{ id: 4 }, { id: 3 }]), [{ id: 5 }, { id: 4 }, { id: 3 }]);
});

test('actionKey and originKey translate only known values', () => {
  assert.equal(actionKey('task_run'), 'settings.activity.actions.task_run');
  assert.equal(actionKey('from_the_future'), null);
  assert.equal(originKey('auth'), 'settings.activity.origins.auth');
  assert.equal(originKey('nope'), null);
});

test('retrySeconds rounds up and is at least 1', () => {
  assert.equal(retrySeconds(1500), 2);
  assert.equal(retrySeconds(0), 1);
  assert.equal(retrySeconds(undefined), 1);
});

test('the update hint is the clone-and-update.sh command (R15)', () => {
  assert.equal(UPDATE_COMMAND, 'git clone https://github.com/solqubit/craftrcon.git && cd craftrcon && sudo ./update.sh');
});
