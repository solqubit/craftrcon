import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS } from '../public/js/data/commands.js';
import { applySuggestion, lastToken, signature, suggest } from '../public/js/lib/autocomplete.js';

const inserts = (list) => list.map((s) => s.insert);
const players = ['Steve', 'Alex', 'stone_miner'];

test("suggest('gam') offers gamemode and gamerule", () => {
  assert.deepEqual(inserts(suggest('gam')), ['gamemode', 'gamerule']);
});

test('suggest ignores a leading slash', () => {
  assert.deepEqual(suggest('/gam'), suggest('gam'));
});

test('a command suggestion shows its syntax and description key', () => {
  const [first] = suggest('gamem');
  assert.deepEqual(first, { insert: 'gamemode', label: 'gamemode <mode> [player]', detail: 'cmd.gamemode' });
});

test('command suggestions are capped at 8 and match case-insensitively', () => {
  assert.equal(suggest('t').length, 8);
  assert.deepEqual(inserts(suggest('GAM')), ['gamemode', 'gamerule']);
});

test('an exact command name comes first', () => {
  assert.deepEqual(inserts(suggest('tp')), ['tp', 'tps']);
  assert.equal(suggest('w')[0].insert, 'w');
});

test("suggest('gamemode cr') offers creative", () => {
  assert.deepEqual(inserts(suggest('gamemode cr')), ['creative']);
});

test('the game mode argument lists every mode when empty', () => {
  assert.deepEqual(inserts(suggest('gamemode ')), ['survival', 'creative', 'adventure', 'spectator']);
  assert.deepEqual(inserts(suggest('defaultgamemode a')), ['adventure']);
});

test("suggest('kick St', { players }) offers Steve", () => {
  assert.deepEqual(inserts(suggest('kick St', { players: ['Steve', 'Alex'] })), ['Steve']);
});

test('player names match case-insensitively and selectors follow them', () => {
  assert.deepEqual(inserts(suggest('kick st', { players })), ['Steve', 'stone_miner']);
  assert.deepEqual(inserts(suggest('op ', { players: ['Steve'] })), ['Steve', '@a', '@p', '@r', '@s', '@e']);
});

test("suggest('tp @') includes the selectors", () => {
  const list = inserts(suggest('tp @'));
  for (const selector of ['@a', '@p', '@r', '@s', '@e']) assert.ok(list.includes(selector), selector);
});

test('player and selector suggestions carry a description key', () => {
  const [steve, all] = suggest('ban ', { players: ['Steve'] });
  assert.deepEqual(steve, { insert: 'Steve', label: 'Steve', detail: 'console.suggest.player' });
  assert.deepEqual(all, { insert: '@a', label: '@a', detail: 'console.suggest.selector.a' });
});

test('the second argument of a command is completed too', () => {
  assert.deepEqual(inserts(suggest('gamemode creative A', { players })), ['Alex']);
  assert.deepEqual(inserts(suggest('tp Steve A', { players })), ['Alex']);
});

test('player suggestions are capped at 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => `P${i}`);
  assert.equal(suggest('kick P', { players: many }).length, 8);
});

test('literal alternatives in the syntax are offered', () => {
  assert.deepEqual(inserts(suggest('weather ')), ['clear', 'rain', 'thunder']);
  assert.deepEqual(inserts(suggest('time s')), ['set']);
  assert.deepEqual(inserts(suggest('whitelist o')), ['off', 'on']);
});

test('well-known values are offered for difficulty, time and gamerules', () => {
  assert.deepEqual(inserts(suggest('difficulty ha')), ['hard']);
  assert.deepEqual(inserts(suggest('time set n')), ['night', 'noon']);
  assert.deepEqual(inserts(suggest('gamerule keepI')), ['keepInventory']);
  assert.deepEqual(inserts(suggest('gamerule keep_')), ['keep_inventory']);
});

test('time values depend on the subcommand', () => {
  assert.deepEqual(inserts(suggest('time set ')), ['day', 'night', 'noon', 'midnight']);
  assert.deepEqual(inserts(suggest('time query ')), ['daytime', 'gametime', 'day']);
  assert.deepEqual(inserts(suggest('time query d')), ['daytime', 'day']);
  assert.deepEqual(inserts(suggest('time QUERY g')), ['gametime']);
  assert.deepEqual(suggest('time add '), []);
  assert.deepEqual(suggest('time constructor '), []); // not an inherited key
  assert.deepEqual(suggest('time __proto__ '), []);
});

test('nothing is suggested for empty input, free text or unknown commands', () => {
  assert.deepEqual(suggest(''), []);
  assert.deepEqual(suggest('   '), []);
  assert.deepEqual(suggest('/'), []);
  assert.deepEqual(suggest('say hel', { players }), []);
  assert.deepEqual(suggest('frobnicate St', { players }), []);
  assert.deepEqual(suggest('gamemode creative Steve x', { players }), []);
  assert.deepEqual(suggest('zzz'), []);
});

test('applySuggestion replaces the last word and adds a space', () => {
  assert.equal(applySuggestion('gam', { insert: 'gamemode' }), 'gamemode ');
  assert.equal(applySuggestion('/gam', { insert: 'gamemode' }), '/gamemode ');
  assert.equal(applySuggestion('gamemode cr', { insert: 'creative' }), 'gamemode creative ');
  assert.equal(applySuggestion('tp ', { insert: '@a' }), 'tp @a ');
  assert.equal(applySuggestion('kick  St', { insert: 'Steve' }), 'kick  Steve ');
});

test('lastToken is the word being typed', () => {
  assert.equal(lastToken('gamemode cr'), 'cr');
  assert.equal(lastToken('/gam'), 'gam');
  assert.equal(lastToken('tp '), '');
  assert.equal(lastToken(''), '');
});

test('signature points at the argument being typed', () => {
  assert.equal(signature('gam'), null);
  assert.equal(signature('nope '), null);
  assert.deepEqual(signature('gamemode '), {
    name: 'gamemode',
    descKey: 'cmd.gamemode',
    args: ['<mode>', '[player]'],
    active: 0,
  });
  assert.equal(signature('/GAMEMODE creative St').active, 1);
  assert.equal(signature('kick Steve you were warned').active, 1); // free text stays on the last argument
  assert.equal(signature('stop ').active, -1);
});

test('COMMANDS: unique names, syntax starting with the name, cmd.<name> keys', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const c of COMMANDS) {
    assert.equal(c.syntax.split(' ')[0], c.name, c.name);
    assert.equal(c.descKey, `cmd.${c.name}`);
  }
});

test('COMMANDS covers the vanilla server commands and Paper tps', () => {
  const expected = `advancement attribute ban ban-ip banlist bossbar clear clone damage data datapack debug
    defaultgamemode deop difficulty effect enchant execute experience xp fill fillbiome forceload function
    gamemode gamerule give help item jfr kick kill list locate loot me msg tell w op pardon pardon-ip particle
    perf place playsound publish random recipe reload return ride save-all save-off save-on say schedule
    scoreboard seed setblock setidletimeout setworldspawn spawnpoint spectate spreadplayers stop stopsound
    summon tag team teammsg teleport tp tellraw tick time title tm transfer trigger weather whitelist
    worldborder tps locatebiome replaceitem`.split(/\s+/);
  const names = new Set(COMMANDS.map((c) => c.name));
  assert.deepEqual(expected.filter((n) => !names.has(n)), []);
});

test('every command has a description in every locale', () => {
  for (const code of ['en', 'es']) {
    const dict = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));
    const missing = COMMANDS.filter((c) => typeof dict.cmd?.[c.name] !== 'string').map((c) => c.name);
    assert.deepEqual(missing, [], code);
  }
});
