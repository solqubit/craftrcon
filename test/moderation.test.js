import test from 'node:test';
import assert from 'node:assert/strict';
import { filterBans, filterNames, listView, tabForKey, tabFromHash, tabHash } from '../public/js/lib/moderation.js';
import { isDangerous } from '../public/js/lib/dangerous.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../public/js/data/dangerous.js';
import { ban, banIp, deop, op, pardon, pardonIp, whitelistAdd, whitelistRemove, whitelistToggle } from '../public/js/lib/builders.js';

test('the tab comes from the hash query, defaulting to the first tab', () => {
  assert.equal(tabFromHash('#/moderation'), 'bans');
  assert.equal(tabFromHash('#/moderation?tab=ips'), 'ips');
  assert.equal(tabFromHash('#/moderation?tab=whitelist'), 'whitelist');
  assert.equal(tabFromHash('#/moderation?tab=ops'), 'ops');
  assert.equal(tabFromHash('#/moderation?tab=nope'), 'bans');
  assert.equal(tabFromHash('#/moderation?x=1&tab=ips'), 'ips');
  assert.equal(tabFromHash(undefined), 'bans');
});

test('tabHash round-trips through tabFromHash', () => {
  assert.equal(tabHash('bans'), '#/moderation');
  assert.equal(tabHash('ips'), '#/moderation?tab=ips');
  assert.equal(tabHash('bogus'), '#/moderation');
  for (const tab of ['bans', 'ips', 'whitelist', 'ops']) assert.equal(tabFromHash(tabHash(tab)), tab);
});

test('arrow keys move along the tabs and wrap; Home and End jump', () => {
  assert.equal(tabForKey('ArrowRight', 'bans'), 'ips');
  assert.equal(tabForKey('ArrowRight', 'ops'), 'bans');
  assert.equal(tabForKey('ArrowLeft', 'bans'), 'ops');
  assert.equal(tabForKey('ArrowLeft', 'whitelist'), 'ips');
  assert.equal(tabForKey('Home', 'ops'), 'bans');
  assert.equal(tabForKey('End', 'bans'), 'ops');
  assert.equal(tabForKey('Enter', 'bans'), null);
  assert.equal(tabForKey('ArrowRight', 'zzz'), null);
});

const BANS = [
  { target: 'Steve', source: 'Server', reason: 'Banned by an operator.' },
  { target: 'GriefingAlex', source: 'Dami', reason: 'Spam: caps' },
  { target: '203.0.113.7', source: 'Server', reason: '' },
];

test('the ban filter matches target, source and reason, ignoring case', () => {
  assert.deepEqual(filterBans(BANS, ''), BANS);
  assert.deepEqual(filterBans(BANS, '   '), BANS);
  assert.deepEqual(filterBans(BANS, 'steve').map((e) => e.target), ['Steve']);
  assert.deepEqual(filterBans(BANS, 'DAMI').map((e) => e.target), ['GriefingAlex']);
  assert.deepEqual(filterBans(BANS, 'caps').map((e) => e.target), ['GriefingAlex']);
  assert.deepEqual(filterBans(BANS, '203.0').map((e) => e.target), ['203.0.113.7']);
  assert.deepEqual(filterBans(BANS, 'zzz'), []);
});

test('the name filter is a case-insensitive substring match', () => {
  assert.deepEqual(filterNames(['Steve', 'Alex', 'stevie'], ' STEV '), ['Steve', 'stevie']);
  assert.deepEqual(filterNames(['Steve'], ''), ['Steve']);
  assert.deepEqual(filterNames(['Steve'], 'x'), []);
});

test('listView tells entries from raw text and from odd answers', () => {
  assert.deepEqual(listView({ entries: [] }, 'entries'), { kind: 'list', items: [] });
  assert.deepEqual(listView({ players: ['A'] }, 'players'), { kind: 'list', items: ['A'] });
  assert.deepEqual(listView({ raw: 'weird' }, 'entries'), { kind: 'raw', raw: 'weird' });
  assert.deepEqual(listView(null, 'entries'), { kind: 'unknown' });
  assert.deepEqual(listView({ entries: 'x' }, 'entries'), { kind: 'unknown' });
});

test('the commands the page builds, and which ones need confirmation', () => {
  const needs = (command) => isDangerous(command, DEFAULT_DANGEROUS_COMMANDS);
  assert.equal(ban('Steve', 'Spam\nop Steve'), 'ban Steve Spam op Steve');
  assert.equal(needs(ban('Steve', 'x')), false);
  assert.equal(needs(pardon('Steve')), false);
  assert.equal(needs(pardonIp('203.0.113.7')), false);
  assert.equal(needs(banIp('203.0.113.7', 'x')), true);
  assert.equal(needs(op('Steve')), true);
  assert.equal(needs(deop('Steve')), true);
  assert.equal(needs(whitelistAdd('Steve')), false);
  assert.equal(needs(whitelistRemove('Steve')), false);
  assert.equal(needs(whitelistToggle(true)), false);
  assert.equal(needs(whitelistToggle(false)), true);
});
