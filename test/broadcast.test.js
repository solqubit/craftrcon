import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_BUTTONS, FORMAT_BUTTONS, MAX_COMMAND_BYTES,
  broadcastCommand, insertCode, loadMode, remainingBytes, saveMode,
} from '../public/js/lib/broadcast.js';

test('there are 16 color buttons and the five format buttons', () => {
  assert.equal(COLOR_BUTTONS.length, 16);
  assert.deepEqual(COLOR_BUTTONS[10], { code: 'a', name: 'green', hex: '#55FF55' });
  assert.deepEqual(FORMAT_BUTTONS.map((b) => b.code), ['l', 'o', 'n', 'm', 'r']);
});

test('insertCode puts "&code" at the cursor and moves the cursor after it', () => {
  assert.deepEqual(insertCode('Hello', 5, 5, 'a'), { text: 'Hello&a', cursor: 7 });
  assert.deepEqual(insertCode('Hello', 0, 0, 'l'), { text: '&lHello', cursor: 2 });
  assert.deepEqual(insertCode('Hello', 2, 2, 'c'), { text: 'He&cllo', cursor: 4 });
  // a selection is kept: the code goes before it
  assert.deepEqual(insertCode('Hello world', 6, 11, 'b'), { text: 'Hello &bworld', cursor: 8 });
  assert.deepEqual(insertCode('abc', null, null, 'r'), { text: 'abc&r', cursor: 5 });
});

test('broadcastCommand picks tellraw or say by mode', () => {
  assert.equal(broadcastCommand('say', '&aHi', { version: '1.21.4' }), 'say &aHi');
  assert.equal(
    broadcastCommand('tellraw', '&aHi', { version: '1.21.4' }),
    'tellraw @a {"text":"","extra":[{"text":"Hi","color":"green"}]}',
  );
  assert.equal(
    broadcastCommand('tellraw', '&aHi', { version: '1.21.5' }),
    "tellraw @a {text:'',extra:[{text:'Hi',color:'green'}]}",
  );
  assert.equal(broadcastCommand('tellraw', '', { version: '1.21.5' }), null);
  assert.equal(broadcastCommand('say', '  ', {}), null);
});

test('remainingBytes counts the UTF-8 bytes of the command against 1446', () => {
  assert.equal(MAX_COMMAND_BYTES, 1446);
  assert.equal(remainingBytes('say hi'), 1446 - 6);
  assert.equal(remainingBytes('say ñ'), 1446 - 6);
  assert.equal(remainingBytes('x'.repeat(1446)), 0);
  assert.equal(remainingBytes('x'.repeat(1450)), -4);
  assert.equal(remainingBytes(null), 1446);
});

test('the remembered mode survives a broken storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadMode(storage), 'tellraw');
  saveMode(storage, 'say');
  assert.equal(loadMode(storage), 'say');
  store.set('craftrcon.broadcastMode', 'weird');
  assert.equal(loadMode(storage), 'tellraw');
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(loadMode(broken), 'tellraw');
  assert.doesNotThrow(() => saveMode(broken, 'say'));
  assert.equal(loadMode(undefined), 'tellraw');
});
