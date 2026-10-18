import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseList, parseBanlist, parseWhitelist, parseTps, parseGamerule,
} from '../src/minecraft/parsers.js';
import { validateCommand, isValidPlayerName } from '../src/minecraft/validate.js';

test('parseList', async (t) => {
  const cases = [
    ['modern', 'There are 2 of a max of 20 players online: Steve, Alex', { online: 2, max: 20, players: ['Steve', 'Alex'] }],
    ['empty', 'There are 0 of a max of 20 players online:', { online: 0, max: 20, players: [] }],
    ['empty with trailing space', 'There are 0 of a max of 20 players online: ', { online: 0, max: 20, players: [] }],
    ['old format', 'There are 2/20 players online:Steve, Alex', { online: 2, max: 20, players: ['Steve', 'Alex'] }],
    ['colored', '§6There are §a2§6 of a max of §a20§6 players online: §fSteve§r, Alex', { online: 2, max: 20, players: ['Steve', 'Alex'] }],
    ['single group prefix', 'There are 2 of a max of 20 players online: default: Steve, Alex', { online: 2, max: 20, players: ['Steve', 'Alex'] }],
    ['group lines', 'There are 3 of a max of 20 players online: \ndefault: Steve, Alex\nadmin: Bob', { online: 3, max: 20, players: ['Steve', 'Alex', 'Bob'] }],
    ['bracket prefix', 'There are 2 of a max of 20 players online: [Admin] Steve, [Mod] Alex', { online: 2, max: 20, players: ['Steve', 'Alex'] }],
    ['extra commas and spaces', 'There are 2 of a max of 20 players online:  Steve ,, Alex, ', { online: 2, max: 20, players: ['Steve', 'Alex'] }],
  ];
  for (const [name, input, expected] of cases) {
    await t.test(name, () => assert.deepEqual(parseList(input), expected));
  }
});

test('parseList returns raw for unrecognized input', () => {
  assert.deepEqual(parseList('basura'), { raw: 'basura' });
  assert.deepEqual(parseList(''), { raw: '' });
  assert.deepEqual(parseList('§aweird §ctext'), { raw: '§aweird §ctext' });
});

test('parseBanlist', async (t) => {
  const cases = [
    ['no bans', 'There are no bans', { entries: [] }],
    ['zero header', 'There are 0 ban(s):', { entries: [] }],
    ['newline separated', 'There are 2 ban(s):\nSteve was banned by Server: Griefing\nAlex was banned by Dami: Spam',
      { entries: [{ target: 'Steve', source: 'Server', reason: 'Griefing' }, { target: 'Alex', source: 'Dami', reason: 'Spam' }] }],
    ['concatenated (vanilla RCON)', 'There are 2 ban(s):Steve was banned by Server: GriefingAlex was banned by Dami: Spam',
      { entries: [{ target: 'Steve', source: 'Server', reason: 'Griefing' }, { target: 'Alex', source: 'Dami', reason: 'Spam' }] }],
    ['concatenated after punctuation', 'There are 2 ban(s):Steve was banned by Server: Banned by an operator.DarkKnight was banned by Dami: Banned by an operator.',
      { entries: [{ target: 'Steve', source: 'Server', reason: 'Banned by an operator.' }, { target: 'DarkKnight', source: 'Dami', reason: 'Banned by an operator.' }] }],
    ['concatenated multi-word reason', 'There are 2 ban(s):Steve was banned by Server: Using hacksAlex was banned by Dami: Spam',
      { entries: [{ target: 'Steve', source: 'Server', reason: 'Using hacks' }, { target: 'Alex', source: 'Dami', reason: 'Spam' }] }],
    ['reason with colons', 'There are 1 ban(s):Steve was banned by Server: Reason: see ticket: 42',
      { entries: [{ target: 'Steve', source: 'Server', reason: 'Reason: see ticket: 42' }] }],
    ['ip ban', 'There are 2 ban(s):\n1.2.3.4 was banned by Server: Botnet\nSteve was banned by Dami: x',
      { entries: [{ target: '1.2.3.4', source: 'Server', reason: 'Botnet' }, { target: 'Steve', source: 'Dami', reason: 'x' }] }],
    ['ip ban concatenated', 'There are 2 ban(s):Steve was banned by Server: Spam.1.2.3.4 was banned by Dami: Botnet',
      { entries: [{ target: 'Steve', source: 'Server', reason: 'Spam.' }, { target: '1.2.3.4', source: 'Dami', reason: 'Botnet' }] }],
    ['empty reason', 'There are 1 ban(s):\nSteve was banned by Server:', { entries: [{ target: 'Steve', source: 'Server', reason: '' }] }],
    ['colored', '§cThere are 1 ban(s):\nSteve was banned by Server: §eHi', { entries: [{ target: 'Steve', source: 'Server', reason: 'Hi' }] }],
  ];
  for (const [name, input, expected] of cases) {
    await t.test(name, () => assert.deepEqual(parseBanlist(input), expected));
  }
});

test('parseBanlist returns raw for unrecognized input', () => {
  assert.deepEqual(parseBanlist('garbage'), { raw: 'garbage' });
  assert.deepEqual(parseBanlist('There are 1 ban(s):\nnot a ban line'), { raw: 'There are 1 ban(s):\nnot a ban line' });
});

test('parseWhitelist', async (t) => {
  const cases = [
    ['paren form', 'There are 2 whitelisted player(s): a, b', { players: ['a', 'b'] }],
    ['plural form', 'There are 2 whitelisted players: Steve, Alex', { players: ['Steve', 'Alex'] }],
    ['none', 'There are no whitelisted players', { players: [] }],
  ];
  for (const [name, input, expected] of cases) {
    await t.test(name, () => assert.deepEqual(parseWhitelist(input), expected));
  }
  assert.deepEqual(parseWhitelist('nope'), { raw: 'nope' });
});

test('parseTps', () => {
  assert.deepEqual(parseTps('§6TPS from last 1m, 5m, 15m: §a20.0, §a*20.0, §a19.97'), [20, 20, 19.97]);
  assert.deepEqual(parseTps('TPS from last 1m, 5m, 15m: 18.5, 19.2, 20.0'), [18.5, 19.2, 20]);
  assert.equal(parseTps('hello'), null);
  assert.equal(parseTps('TPS from last 1m, 5m, 15m: 20.0'), null);
});

test('parseGamerule', () => {
  assert.deepEqual(parseGamerule('Gamerule keepInventory is currently set to: false'), { name: 'keepInventory', value: 'false' });
  assert.deepEqual(parseGamerule('Gamerule randomTickSpeed is currently set to: 3'), { name: 'randomTickSpeed', value: '3' });
  assert.deepEqual(parseGamerule('Gamerule doFireTick is now set to: true'), { name: 'doFireTick', value: 'true' });
  assert.equal(parseGamerule('Incorrect argument'), null);
});

test('validateCommand', () => {
  assert.deepEqual(validateCommand('/say hola'), { ok: true, command: 'say hola' });
  assert.deepEqual(validateCommand('  say hola  '), { ok: true, command: 'say hola' });
  assert.deepEqual(validateCommand('say ¡Hola, señores!'), { ok: true, command: 'say ¡Hola, señores!' });
  assert.deepEqual(validateCommand('say a\nstop'), { ok: false, error: 'invalid_chars' });
  assert.deepEqual(validateCommand('say a\rstop'), { ok: false, error: 'invalid_chars' });
  assert.deepEqual(validateCommand('say a\0'), { ok: false, error: 'invalid_chars' });
  assert.deepEqual(validateCommand(''), { ok: false, error: 'empty' });
  assert.deepEqual(validateCommand('  / '), { ok: false, error: 'empty' });
  assert.deepEqual(validateCommand(undefined), { ok: false, error: 'empty' });
  assert.deepEqual(validateCommand('x'.repeat(1446)), { ok: true, command: 'x'.repeat(1446) });
  assert.deepEqual(validateCommand('x'.repeat(1447)), { ok: false, error: 'too_long' });
  assert.deepEqual(validateCommand('/' + 'x'.repeat(1446)), { ok: true, command: 'x'.repeat(1446) });
});

test('validateCommand counts bytes, not characters', () => {
  assert.equal(validateCommand('ñ'.repeat(723)).ok, true); // 1446 bytes
  assert.deepEqual(validateCommand('ñ'.repeat(724)), { ok: false, error: 'too_long' }); // 1448 bytes
  assert.deepEqual(validateCommand('😀'.repeat(362)), { ok: false, error: 'too_long' }); // 1448 bytes
});

test('validate re-exports isValidPlayerName', () => {
  assert.equal(isValidPlayerName('Steve'), true);
  assert.equal(isValidPlayerName('../x'), false);
});
