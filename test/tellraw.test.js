import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacy } from '../public/js/lib/mctext.js';
import { buildSay, buildTellraw, segmentsToComponent, usesSnbt } from '../public/js/lib/tellraw.js';

const PREFIX = 'tellraw @a ';

test('usesSnbt: Java 1.21.5 and later, and the year-based versions', () => {
  assert.equal(usesSnbt('Vanilla 1.20.1'), false);
  assert.equal(usesSnbt('Paper 1.21.4'), false);
  assert.equal(usesSnbt('1.21.5'), true);
  assert.equal(usesSnbt('Paper 1.21.8'), true);
  assert.equal(usesSnbt('Paper 1.22'), true);
  assert.equal(usesSnbt('1.21'), false);
  assert.equal(usesSnbt('Paper 26.1'), true);
  assert.equal(usesSnbt('Paper 1.21.4-R0.1-SNAPSHOT'), false);
});

test('usesSnbt: snapshots and unknown versions are not SNBT', () => {
  assert.equal(usesSnbt('24w14a'), false);
  assert.equal(usesSnbt('Snapshot 25w10a'), false);
  assert.equal(usesSnbt(''), false);
  assert.equal(usesSnbt(undefined), false);
  assert.equal(usesSnbt('Mystery'), false);
});

test('segmentsToComponent: named colors, hex colors and only the formats that are on', () => {
  const component = segmentsToComponent(parseLegacy('&aHi &l&nbold&r plain &#x', { ampersand: true }));
  assert.equal(component.text, '');
  assert.deepEqual(component.extra, [
    { text: 'Hi ', color: 'green' },
    { text: 'bold', color: 'green', bold: true, underlined: true },
    { text: ' plain &#x' },
  ]);
  const hex = segmentsToComponent(parseLegacy('§x§1§2§3§4§5§6hex', { ampersand: false }));
  assert.deepEqual(hex.extra, [{ text: 'hex', color: '#123456' }]);
  const all = segmentsToComponent(parseLegacy('&cx&ly&oz&m!&k?', { ampersand: true }));
  assert.deepEqual(all.extra[4], { text: '?', color: 'red', bold: true, italic: true, strikethrough: true, obfuscated: true });
});

test('buildTellraw (JSON): valid JSON with the colors and formats', () => {
  const command = buildTellraw('&aHola &lmundo', { version: 'Paper 1.21.4' });
  assert.ok(command.startsWith(PREFIX));
  const component = JSON.parse(command.slice(PREFIX.length));
  assert.equal(component.extra[0].color, 'green');
  assert.equal(component.extra[0].text, 'Hola ');
  assert.equal(component.extra[1].color, 'green');
  assert.equal(component.extra[1].bold, true);
});

test('buildTellraw (SNBT, 1.21.5+): not JSON, unquoted keys, single-quoted strings', () => {
  const command = buildTellraw('&aHola &lmundo', { version: '1.21.5' });
  assert.ok(command.startsWith('tellraw @a {'));
  assert.throws(() => JSON.parse(command.slice(PREFIX.length)));
  assert.ok(command.includes("color:'green'"));
  assert.equal(command, "tellraw @a {text:'',extra:[{text:'Hola ',color:'green'},{text:'mundo',color:'green',bold:true}]}");
});

test('buildTellraw: single quotes and backslashes are escaped in SNBT', () => {
  const command = buildTellraw("it's a \\ test", { version: '1.21.5' });
  assert.equal(command, "tellraw @a {text:'',extra:[{text:'it\\'s a \\\\ test'}]}");
});

test('buildTellraw: line breaks become one line, never a second command', () => {
  for (const version of ['1.21.4', '1.21.5']) {
    const command = buildTellraw("a'b\nc\r\nd\0e", { version });
    assert.doesNotMatch(command, /[\r\n\0]/);
    assert.ok(command.includes('a'));
  }
  const json = JSON.parse(buildTellraw('a\nb', { version: '1.20' }).slice(PREFIX.length));
  assert.equal(json.extra[0].text, 'a b');
});

test('buildTellraw: another target; non-ASCII text is kept; an empty message throws', () => {
  assert.ok(buildTellraw('¡Hola, señores!', { version: '1.20', target: 'Steve' }).startsWith('tellraw Steve {'));
  assert.ok(buildTellraw('¡Hola, señores!', { version: '1.20' }).includes('¡Hola, señores!'));
  for (const empty of ['', '   ', '\n', '&a&l', undefined]) {
    assert.throws(() => buildTellraw(empty, { version: '1.20' }), { message: 'empty_message' });
  }
});

test('buildSay: say plus the message on one line', () => {
  assert.equal(buildSay('Hello there'), 'say Hello there');
  assert.equal(buildSay('a\nb'), 'say a b');
  assert.equal(buildSay('¡Hola, señores!'), 'say ¡Hola, señores!');
  assert.throws(() => buildSay('  \n '), { message: 'empty_message' });
});
