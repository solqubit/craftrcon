import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offlineErrorKey, playersView, tail, tpsLevel, tpsText, versionLabel } from '../public/js/lib/dashboard.js';
import { getScreen, nextSendId, updateScreen } from '../public/js/lib/screens.js';

test('tpsLevel: green from 18, amber from 15, red below', () => {
  assert.equal(tpsLevel(20), 'good');
  assert.equal(tpsLevel(18), 'good');
  assert.equal(tpsLevel(17.99), 'warn');
  assert.equal(tpsLevel(15), 'warn');
  assert.equal(tpsLevel(14.9), 'bad');
  assert.equal(tpsLevel(0), 'bad');
  assert.equal(tpsLevel(NaN), null);
  assert.equal(tpsLevel(null), null);
});

test('tpsText: one decimal, never above 20', () => {
  assert.equal(tpsText(19.8), '19.8');
  assert.equal(tpsText(20), '20.0');
  assert.equal(tpsText(20.4), '20.0');
  assert.equal(tpsText(12.34), '12.3');
});

test('versionLabel: does not repeat the software already in the version name', () => {
  assert.equal(versionLabel('Paper 1.21.4', 'Paper'), 'Paper 1.21.4');
  assert.equal(versionLabel('1.21.4', 'Vanilla'), 'Vanilla 1.21.4');
  assert.equal(versionLabel('1.21.4', null), '1.21.4');
  assert.equal(versionLabel('', 'Paper'), 'Paper');
  assert.equal(versionLabel(null, null), '');
});

test('offlineErrorKey: one message per ping error code, a generic one otherwise', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'TIMEOUT', 'PROTOCOL']) {
    assert.equal(offlineErrorKey(code), `dashboard.offline.error.${code}`);
  }
  assert.equal(offlineErrorKey('weird'), 'dashboard.offline.error.PROTOCOL');
  assert.equal(offlineErrorKey(undefined), 'dashboard.offline.error.PROTOCOL');
});

test('tail: the last n items, same array when it already fits', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(tail(list, 6), [3, 4, 5, 6, 7, 8]);
  const short = [1, 2];
  assert.equal(tail(short, 6), short);
  assert.deepEqual(tail([], 6), []);
});

test('playersView: names, raw text, or nothing', () => {
  assert.deepEqual(playersView({ online: 2, max: 20, players: ['Steve', 'Alex'] }), { kind: 'list', names: ['Steve', 'Alex'] });
  assert.deepEqual(playersView({ online: 0, max: 20, players: [] }), { kind: 'list', names: [] });
  assert.deepEqual(playersView({ raw: 'Something odd' }), { kind: 'raw', raw: 'Something odd' });
  assert.equal(playersView(null), null);
  assert.equal(playersView('x'), null);
});

test('screens: updateScreen stores the trimmed log per server; ids are unique', () => {
  assert.deepEqual(getScreen(901), []);
  const next = updateScreen(901, (log) => [...log, { id: 1, command: 'list', pending: true, ok: true }]);
  assert.equal(next.length, 1);
  assert.equal(getScreen(901), next);
  assert.equal(updateScreen(901, (log) => log), next);
  assert.deepEqual(getScreen(902), []);
  assert.notEqual(nextSendId(), nextSendId());
});
