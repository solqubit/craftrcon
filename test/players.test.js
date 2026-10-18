import test from 'node:test';
import assert from 'node:assert/strict';
import { DIALOG_ACTIONS, DIRECT_ACTIONS, buildAction, errorField, suggestItems } from '../public/js/lib/players.js';
import { isDangerous } from '../public/js/lib/dangerous.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../public/js/data/dangerous.js';

test('each action builds the command for the player', () => {
  assert.equal(buildAction('kick', 'Steve', { reason: 'Griefing\nstop' }), 'kick Steve Griefing stop');
  assert.equal(buildAction('kick', 'Steve', { reason: '' }), 'kick Steve');
  assert.equal(buildAction('ban', 'Steve', { reason: 'Cheating' }), 'ban Steve Cheating');
  assert.equal(buildAction('op', 'Steve'), 'op Steve');
  assert.equal(buildAction('deop', 'Steve'), 'deop Steve');
  assert.equal(buildAction('whitelistAdd', 'Steve'), 'whitelist add Steve');
  assert.equal(buildAction('whitelistRemove', 'Steve'), 'whitelist remove Steve');
  assert.equal(buildAction('gamemode', 'Steve', { mode: 'creative' }), 'gamemode creative Steve');
  assert.equal(buildAction('teleport', 'Steve', { tpMode: 'player', target: 'Alex' }), 'tp Steve Alex');
  assert.equal(buildAction('teleport', 'Steve', { tpMode: 'coords', x: '~', y: '64', z: '-10' }), 'tp Steve ~ 64 -10');
  assert.equal(buildAction('give', 'Steve', { item: 'diamond_sword', count: '1' }), 'give Steve diamond_sword 1');
  assert.equal(buildAction('tell', 'Steve', { message: 'Hola' }), 'tell Steve Hola');
});

test('every action the page offers can be built', () => {
  const values = { reason: '', mode: 'survival', tpMode: 'player', target: 'Alex', item: 'stone', count: 1, message: 'hi' };
  for (const action of [...DIALOG_ACTIONS, ...DIRECT_ACTIONS]) assert.equal(typeof buildAction(action, 'Steve', values), 'string');
  assert.throws(() => buildAction('explode', 'Steve'), /unknown_action/);
});

test('invalid values and names throw the builder codes', () => {
  assert.throws(() => buildAction('op', '../x'), /invalid_player/);
  assert.throws(() => buildAction('give', 'Steve', { item: 'stone', count: 0 }), /invalid_count/);
  assert.throws(() => buildAction('give', 'Steve', { item: '', count: 1 }), /invalid_item/);
  assert.throws(() => buildAction('teleport', 'Steve', { tpMode: 'coords', x: '', y: '0', z: '0' }), /invalid_coords/);
  assert.throws(() => buildAction('teleport', 'Steve', { tpMode: 'player', target: '' }), /invalid_player/);
  assert.throws(() => buildAction('tell', 'Steve', { message: ' ' }), /empty_message/);
});

test('built op and deop commands hit the dangerous list, kick does not', () => {
  const dangerous = (action) => isDangerous(buildAction(action, 'Steve', { reason: '' }), DEFAULT_DANGEROUS_COMMANDS);
  assert.equal(dangerous('op'), true);
  assert.equal(dangerous('deop'), true);
  assert.equal(dangerous('kick'), false);
  assert.equal(dangerous('whitelistAdd'), false);
});

test('errors map to the field they belong to', () => {
  assert.equal(errorField('invalid_item', 'give'), 'item');
  assert.equal(errorField('invalid_count', 'give'), 'count');
  assert.equal(errorField('invalid_coords', 'teleport'), 'coords');
  assert.equal(errorField('empty_message', 'tell'), 'message');
  assert.equal(errorField('invalid_player', 'teleport'), 'target');
  assert.equal(errorField('invalid_player', 'kick'), 'form');
  assert.equal(errorField('invalid_mode', 'gamemode'), 'form');
});

test('item suggestions rank prefixes first and cap the list', () => {
  const items = ['diamond', 'diamond_axe', 'golden_apple', 'apple', 'pineapple_x', 'stone'];
  assert.deepEqual(suggestItems('apple', items), ['apple', 'golden_apple', 'pineapple_x']);
  assert.deepEqual(suggestItems('  Minecraft:Diamond ', items), ['diamond', 'diamond_axe']);
  assert.deepEqual(suggestItems('diamond a', items), ['diamond_axe']);
  assert.deepEqual(suggestItems('', items), []);
  assert.deepEqual(suggestItems('zzz', items), []);
  assert.deepEqual(suggestItems('d', items, 1), ['diamond']);
  assert.equal(suggestItems('a').length, 8);
});

test('the real item list suggests diamond_sword for "diamond_sw"', () => {
  assert.equal(suggestItems('diamond_sw')[0], 'diamond_sword');
});
