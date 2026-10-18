import test from 'node:test';
import assert from 'node:assert/strict';
import { stripCodes, parseLegacy } from '../public/js/lib/mctext.js';
import { isValidPlayerName, oneLine } from '../public/js/lib/names.js';

const plain = { color: null, bold: false, italic: false, underline: false, strike: false, obfuscated: false };

test('stripCodes removes section and ampersand codes', () => {
  assert.equal(stripCodes('§6TPS §a20.0'), 'TPS 20.0');
  assert.equal(stripCodes('&cRed &lbold&r end'), 'Red bold end');
  assert.equal(stripCodes('§K§L§M§N§O§R§A'), '');
  assert.equal(stripCodes('plain'), 'plain');
});

test('stripCodes removes hex sequences and unknown § codes', () => {
  assert.equal(stripCodes('§x§f§f§a§a§0§0Hi'), 'Hi');
  assert.equal(stripCodes('a§zb§'), 'ab');
});

test('stripCodes keeps a literal ampersand that is not a code', () => {
  assert.equal(stripCodes('Tom & Jerry'), 'Tom & Jerry');
  assert.equal(stripCodes('R&D', { ampersand: false }), 'R&D');
});

test('parseLegacy: color, bold and reset', () => {
  assert.deepEqual(parseLegacy('§aHi §lB§rC'), [
    { text: 'Hi ', ...plain, color: '#55FF55' },
    { text: 'B', ...plain, color: '#55FF55', bold: true },
    { text: 'C', ...plain },
  ]);
});

test('parseLegacy: all sixteen colors map to the standard hex values', () => {
  const expected = {
    0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA',
    6: '#FFAA00', 7: '#AAAAAA', 8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF',
    c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
  };
  for (const [code, hex] of Object.entries(expected)) {
    assert.deepEqual(parseLegacy(`§${code}x`), [{ text: 'x', ...plain, color: hex }], code);
  }
});

test('parseLegacy: every format code, case-insensitive', () => {
  assert.deepEqual(parseLegacy('§Kk§lb§Mm§nu§oi'), [
    { text: 'k', ...plain, obfuscated: true },
    { text: 'b', ...plain, obfuscated: true, bold: true },
    { text: 'm', ...plain, obfuscated: true, bold: true, strike: true },
    { text: 'u', ...plain, obfuscated: true, bold: true, strike: true, underline: true },
    { text: 'i', ...plain, obfuscated: true, bold: true, strike: true, underline: true, italic: true },
  ]);
});

test('parseLegacy: a color code resets the formats', () => {
  assert.deepEqual(parseLegacy('§l§nA§cB'), [
    { text: 'A', ...plain, bold: true, underline: true },
    { text: 'B', ...plain, color: '#FF5555' },
  ]);
});

test('parseLegacy: hex color sequence', () => {
  assert.deepEqual(parseLegacy('§x§F§f§a§a§0§0Hi'), [{ text: 'Hi', ...plain, color: '#FFAA00' }]);
});

test('parseLegacy: incomplete hex sequence drops only the §x', () => {
  // "§x" is dropped; "§f" then colors the rest, and the second "§f" is a plain color code.
  assert.deepEqual(parseLegacy('§x§f§fHi'), [{ text: 'Hi', ...plain, color: '#FFFFFF' }]);
});

test('parseLegacy: merges identical neighbours and omits empty segments', () => {
  assert.deepEqual(parseLegacy('§a§aA§aB§r§rC'), [
    { text: 'AB', ...plain, color: '#55FF55' },
    { text: 'C', ...plain },
  ]);
  assert.deepEqual(parseLegacy('§a§l'), []);
  assert.deepEqual(parseLegacy(''), []);
});

test('parseLegacy: unknown codes are dropped silently', () => {
  assert.deepEqual(parseLegacy('a§zb§'), [{ text: 'ab', ...plain }]);
});

test('parseLegacy: ampersand is literal unless enabled', () => {
  assert.deepEqual(parseLegacy('&aHi'), [{ text: '&aHi', ...plain }]);
  assert.deepEqual(parseLegacy('&aHi & bye', { ampersand: true }), [
    { text: 'Hi & bye', ...plain, color: '#55FF55' },
  ]);
});

test('isValidPlayerName', () => {
  for (const ok of ['Steve', 'a', 'Name_123', 'x'.repeat(16)]) assert.equal(isValidPlayerName(ok), true, ok);
  for (const bad of ['', 'x'.repeat(17), '../../etc/passwd', 'a b', 'Steve\n', 'ñandú', null, undefined, 5]) {
    assert.equal(isValidPlayerName(bad), false, String(bad));
  }
});

test('oneLine collapses CR/LF runs to one space and removes NUL', () => {
  assert.equal(oneLine('a\r\n\r\nb\nc\rd'), 'a b c d');
  assert.equal(oneLine('a\0b'), 'ab');
  assert.equal(oneLine('plain'), 'plain');
});
