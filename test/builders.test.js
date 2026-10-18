import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ban,
  banIp,
  deop,
  give,
  gamemode,
  kick,
  op,
  pardon,
  pardonIp,
  tell,
  tpToCoords,
  tpToPlayer,
  whitelistAdd,
  whitelistRemove,
  whitelistToggle,
} from '../public/js/lib/builders.js';
import { ITEMS } from '../public/js/data/items.js';

const throwsCode = (fn, message) => assert.throws(fn, (err) => err instanceof Error && err.message === message);

test('kick and ban add the reason on one line, or none', () => {
  assert.equal(kick('Steve', 'Griefing\nstop'), 'kick Steve Griefing stop');
  assert.equal(kick('Steve'), 'kick Steve');
  assert.equal(kick('Steve', '  \r\n '), 'kick Steve');
  assert.equal(kick('Steve', ''), 'kick Steve');
  assert.equal(ban('Steve', 'x\0y\r\nz'), 'ban Steve xy z');
  assert.equal(ban('Steve', undefined), 'ban Steve');
  assert.equal(ban('Steve', '  Cheating  '), 'ban Steve Cheating');
});

test('ban-ip takes an IP or an online player name', () => {
  assert.equal(banIp('203.0.113.7', 'spam'), 'ban-ip 203.0.113.7 spam');
  assert.equal(banIp('Steve'), 'ban-ip Steve');
  assert.equal(banIp('2001:db8::1'), 'ban-ip 2001:db8::1');
  assert.equal(pardonIp('203.0.113.7'), 'pardon-ip 203.0.113.7');
  throwsCode(() => banIp('999.1.1.1'), 'invalid_ip');
  throwsCode(() => banIp('1.2.3'), 'invalid_ip');
  throwsCode(() => banIp('a b'), 'invalid_player');
  throwsCode(() => pardonIp('Steve'), 'invalid_ip');
  throwsCode(() => pardonIp('1.2.3.4 extra'), 'invalid_ip');
});

test('simple player commands', () => {
  assert.equal(pardon('Steve'), 'pardon Steve');
  assert.equal(op('Steve'), 'op Steve');
  assert.equal(deop('Steve_1'), 'deop Steve_1');
  assert.equal(whitelistAdd('Steve'), 'whitelist add Steve');
  assert.equal(whitelistRemove('Steve'), 'whitelist remove Steve');
  assert.equal(whitelistToggle(true), 'whitelist on');
  assert.equal(whitelistToggle(false), 'whitelist off');
});

test('every command that takes a player rejects an invalid name', () => {
  const bad = ['../x', '', 'a b', 'Steve\nop Alex', 'abcdefghijklmnopq', '.Bedrock', null, undefined, 5];
  const commands = [
    kick, ban, banIp, pardon, op, deop, whitelistAdd, whitelistRemove,
    (p) => gamemode(p, 'creative'),
    (p) => tpToPlayer(p, 'Alex'),
    (p) => tpToPlayer('Alex', p),
    (p) => tpToCoords(p, 0, 0, 0),
    (p) => give(p, 'stone', 1),
    (p) => tell(p, 'hi'),
  ];
  for (const name of bad) {
    for (const run of commands) throwsCode(() => run(name), 'invalid_player');
  }
  throwsCode(() => op('../x'), 'invalid_player');
});

test('gamemode accepts the four modes', () => {
  for (const mode of ['survival', 'creative', 'adventure', 'spectator']) {
    assert.equal(gamemode('Steve', mode), `gamemode ${mode} Steve`);
  }
  throwsCode(() => gamemode('Steve', 'hardcore'), 'invalid_mode');
  throwsCode(() => gamemode('Steve', 'creative Alex'), 'invalid_mode');
});

test('teleport to a player or to coordinates', () => {
  assert.equal(tpToPlayer('Steve', 'Alex'), 'tp Steve Alex');
  assert.equal(tpToCoords('Steve', '~', '64', '-10'), 'tp Steve ~ 64 -10');
  assert.equal(tpToCoords('Steve', 100, 64.5, -10), 'tp Steve 100 64.5 -10');
  assert.equal(tpToCoords('Steve', '~5', '~-2', '~'), 'tp Steve ~5 ~-2 ~');
  assert.equal(tpToCoords('Steve', '^', '^1', '^-3.5'), 'tp Steve ^ ^1 ^-3.5');
  assert.equal(tpToCoords('Steve', ' 1 ', '2', '3'), 'tp Steve 1 2 3');
});

test('coordinates reject anything that is not a number, ~ or ^', () => {
  for (const bad of ['', 'abc', '1 2', '1;2', '~~', 'NaN', '1e5', '--1', '~a', NaN, Infinity, null, undefined, '1\nstop']) {
    throwsCode(() => tpToCoords('Steve', bad, '0', '0'), 'invalid_coords');
  }
  throwsCode(() => tpToCoords('Steve', '0', 'x', '0'), 'invalid_coords');
  throwsCode(() => tpToCoords('Steve', '0', '0', 'x'), 'invalid_coords');
  // Local (^) and world coordinates can't be mixed.
  throwsCode(() => tpToCoords('Steve', '^1', '2', '3'), 'invalid_coords');
  throwsCode(() => tpToCoords('Steve', '~1', '^2', '3'), 'invalid_coords');
});

test('give checks the item id and the count', () => {
  assert.equal(give('Steve', 'diamond_sword', 1), 'give Steve diamond_sword 1');
  assert.equal(give('Steve', 'minecraft:stone', '64'), 'give Steve minecraft:stone 64');
  assert.equal(give('Steve', 'stone', 6400), 'give Steve stone 6400');
  throwsCode(() => give('Steve', 'x', 0), 'invalid_count');
  throwsCode(() => give('Steve', 'x', 6401), 'invalid_count');
  throwsCode(() => give('Steve', 'x', 1.5), 'invalid_count');
  throwsCode(() => give('Steve', 'x', ''), 'invalid_count');
  throwsCode(() => give('Steve', 'x', 'abc'), 'invalid_count');
  throwsCode(() => give('Steve', 'x', null), 'invalid_count');
  for (const item of ['', 'Stone', 'a b', 'stone{x:1}', 'stone\nop', 'a/b', undefined]) {
    throwsCode(() => give('Steve', item, 1), 'invalid_item');
  }
});

test('tell sends a one-line private message', () => {
  assert.equal(tell('Steve', 'Hola\nseñor'), 'tell Steve Hola señor');
  assert.equal(tell('Steve', '  ¡Hola!  '), 'tell Steve ¡Hola!');
  throwsCode(() => tell('Steve', '  \n '), 'empty_message');
  throwsCode(() => tell('Steve', undefined), 'empty_message');
});

test('the generated item list is sorted, unique and valid for give', () => {
  assert.ok(ITEMS.length > 1000);
  assert.ok(ITEMS.includes('diamond_sword'));
  assert.ok(!ITEMS.includes('air'));
  assert.deepEqual(ITEMS, [...new Set(ITEMS)].sort());
  for (const item of ITEMS) assert.equal(give('Steve', item, 1), `give Steve ${item} 1`);
});
