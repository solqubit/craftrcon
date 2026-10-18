import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DANGEROUS_COMMANDS } from '../public/js/data/dangerous.js';
import { isDangerous } from '../public/js/lib/dangerous.js';

const list = DEFAULT_DANGEROUS_COMMANDS;

test('a command equal to an entry is dangerous', () => {
  assert.equal(isDangerous('stop', list), true);
  assert.equal(isDangerous('kill @e', list), true);
  assert.equal(isDangerous('whitelist off', list), true);
});

test('a command that starts with an entry and a space is dangerous', () => {
  assert.equal(isDangerous('op Steve', list), true);
  assert.equal(isDangerous('difficulty hard', list), true);
  assert.equal(isDangerous('kill @e[type=zombie]', list), false);
  assert.equal(isDangerous('kill @e [type=zombie]', list), true);
});

test('the match is on whole words: a longer command name is not a match', () => {
  assert.equal(isDangerous('stopsound @a', list), false);
  assert.equal(isDangerous('opx', list), false);
  assert.equal(isDangerous('deopx Steve', list), false);
  assert.equal(isDangerous('whitelist on', list), false);
  assert.equal(isDangerous('kill Steve', list), false);
});

test('case, a leading slash and extra spaces do not dodge the check', () => {
  assert.equal(isDangerous('STOP', list), true);
  assert.equal(isDangerous('/stop', list), true);
  assert.equal(isDangerous('  / Op  Steve ', list), true);
  assert.equal(isDangerous('kill   @E', list), true);
  assert.equal(isDangerous('Whitelist\tOFF', list), true);
});

test('entries are normalized the same way', () => {
  assert.equal(isDangerous('ban Steve', [' /BAN ']), true);
  assert.equal(isDangerous('kill @e', ['kill  @e']), true);
});

test('empty commands, empty entries and bad lists never match', () => {
  assert.equal(isDangerous('', list), false);
  assert.equal(isDangerous('   ', list), false);
  assert.equal(isDangerous('stop', []), false);
  assert.equal(isDangerous('stop', ['', '  ']), false);
  assert.equal(isDangerous('stop', null), false);
  assert.equal(isDangerous('stop', [null, 3, 'stop']), true);
});
