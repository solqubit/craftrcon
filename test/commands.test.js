import test from 'node:test';
import assert from 'node:assert/strict';
import { commandReply, confirmationFor, failureCode } from '../public/js/lib/commands.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../public/js/data/dangerous.js';

test('commandReply is the trimmed output, or empty', () => {
  assert.equal(commandReply({ ok: true, output: '  Banned Steve\n' }), 'Banned Steve');
  assert.equal(commandReply({ ok: true, output: '' }), '');
  assert.equal(commandReply({ ok: true }), '');
  assert.equal(commandReply(null), '');
});

test('failureCode maps a 404 to not_found and otherwise keeps the API code', () => {
  assert.equal(failureCode({ status: 404, code: 'http_404' }), 'not_found');
  assert.equal(failureCode({ status: 502, code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(failureCode({ status: 0, code: 'network_error' }), 'network_error');
});

test('confirmationFor: dangerous list first, then the page ask, else none', () => {
  const ask = { title: 'Unban?' };
  assert.deepEqual(confirmationFor('op Steve', DEFAULT_DANGEROUS_COMMANDS), { kind: 'dangerous' });
  assert.deepEqual(confirmationFor('op Steve', DEFAULT_DANGEROUS_COMMANDS, ask), { kind: 'dangerous' });
  assert.deepEqual(confirmationFor('pardon Steve', DEFAULT_DANGEROUS_COMMANDS, ask), { kind: 'ask', ask });
  assert.equal(confirmationFor('pardon Steve', DEFAULT_DANGEROUS_COMMANDS), null);
  assert.deepEqual(confirmationFor('pardon Steve', ['pardon'], ask), { kind: 'dangerous' });
  assert.equal(confirmationFor('say hi', undefined), null);
});
