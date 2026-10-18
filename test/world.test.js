import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES, TIME_PRESETS, WEATHERS,
  difficulty, gamerule, saveAll, timeSet, weather, worldBorderCenter, worldBorderSet,
} from '../public/js/lib/world.js';

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  return null;
};

const RULES = [
  { name: 'keepInventory', type: 'bool', value: 'false' },
  { name: 'random_tick_speed', type: 'int', value: '3' },
];

test('time presets and exact values', () => {
  assert.deepEqual(TIME_PRESETS, { day: 1000, noon: 6000, night: 13000, midnight: 18000 });
  assert.equal(timeSet(TIME_PRESETS.noon), 'time set 6000');
  assert.equal(timeSet('0'), 'time set 0');
  assert.equal(timeSet(' 24000 '), 'time set 24000');
});

test('timeSet rejects anything but an integer from 0 to 24000', () => {
  for (const bad of [-1, 24001, 1.5, '1e3', '', 'abc', null, undefined, NaN, '12 13']) {
    assert.equal(code(() => timeSet(bad)), 'invalid_time', String(bad));
  }
});

test('weather and difficulty take only the known words', () => {
  assert.deepEqual(WEATHERS, ['clear', 'rain', 'thunder']);
  assert.deepEqual(DIFFICULTIES, ['peaceful', 'easy', 'normal', 'hard']);
  assert.equal(weather('rain'), 'weather rain');
  assert.equal(difficulty('hard'), 'difficulty hard');
  assert.equal(code(() => weather('snow')), 'invalid_weather');
  assert.equal(code(() => difficulty('Hard')), 'invalid_difficulty');
});

test('gamerule: names come from the API list only', () => {
  assert.equal(gamerule(RULES, 'keepInventory', true), 'gamerule keepInventory true');
  assert.equal(gamerule(RULES, 'keepInventory', 'false'), 'gamerule keepInventory false');
  assert.equal(gamerule(RULES, 'random_tick_speed', '10'), 'gamerule random_tick_speed 10');
  assert.equal(code(() => gamerule(RULES, 'randomTickSpeed', 3)), 'unknown_gamerule');
  assert.equal(code(() => gamerule(RULES, 'keepInventory; stop', true)), 'unknown_gamerule');
  assert.equal(code(() => gamerule(null, 'keepInventory', true)), 'unknown_gamerule');
  assert.equal(code(() => gamerule(undefined, 'x', 1)), 'unknown_gamerule');
});

test('gamerule: values are validated by type', () => {
  assert.equal(code(() => gamerule(RULES, 'keepInventory', 'yes')), 'invalid_value');
  assert.equal(code(() => gamerule(RULES, 'keepInventory', 1)), 'invalid_value');
  for (const bad of ['', '-1', '1.5', 'abc', '3 4', '99999999999', null]) {
    assert.equal(code(() => gamerule(RULES, 'random_tick_speed', bad)), 'invalid_value', String(bad));
  }
  assert.equal(gamerule(RULES, 'random_tick_speed', 0), 'gamerule random_tick_speed 0');
});

test('worldBorderSet: size 1 to 59999968, optional seconds', () => {
  assert.equal(worldBorderSet('1000'), 'worldborder set 1000');
  assert.equal(worldBorderSet(1000, ''), 'worldborder set 1000');
  assert.equal(worldBorderSet('2500.5', '30'), 'worldborder set 2500.5 30');
  assert.equal(worldBorderSet(59999968), 'worldborder set 59999968');
  assert.equal(worldBorderSet(1, 0), 'worldborder set 1 0');
  for (const bad of [0, 0.5, 59999969, -5, 'abc', '', null, '1e3', '10 20']) {
    assert.equal(code(() => worldBorderSet(bad)), 'invalid_size', String(bad));
  }
  for (const bad of [-1, 1.5, 'x', '1e2', 2147483648]) {
    assert.equal(code(() => worldBorderSet(1000, bad)), 'invalid_seconds', String(bad));
  }
});

test('worldBorderCenter: two numbers inside the world', () => {
  assert.equal(worldBorderCenter('0', '0'), 'worldborder center 0 0');
  assert.equal(worldBorderCenter(-120.5, 300), 'worldborder center -120.5 300');
  for (const [x, z] of [['a', 0], [0, ''], [30000000, 0], [0, -30000000], ['~', 0], [null, 1]]) {
    assert.equal(code(() => worldBorderCenter(x, z)), 'invalid_coords', `${x} ${z}`);
  }
});

test('saveAll', () => {
  assert.equal(saveAll(), 'save-all');
});
