import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

// openLive() runs in the browser: stub `location` and `WebSocket`, and drive
// setTimeout with mocked timers to observe the reconnect schedule.
class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.closedByClient = false;
    FakeSocket.all.push(this);
  }
  open() {
    this.onopen?.();
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  close() {
    this.closedByClient = true;
  }
}

let openLive;

before(async () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'panel.test' },
  });
  globalThis.WebSocket = FakeSocket;
  ({ openLive } = await import('../public/js/api.js'));
});

after(() => {
  delete globalThis.location;
  delete globalThis.WebSocket;
});

// Advances time until the next socket is created; returns the wait in ms.
function waitForNextSocket(maxMs = 120_000) {
  const before = FakeSocket.all.length;
  for (let ms = 1000; ms <= maxMs; ms += 1000) {
    mock.timers.tick(1000);
    if (FakeSocket.all.length > before) return ms;
  }
  return Infinity;
}

test('connects to the server live URL on the same origin', () => {
  FakeSocket.all = [];
  const close = openLive(7, () => {});
  assert.equal(FakeSocket.all[0].url, 'ws://panel.test/api/servers/7/live');
  close();
});

test('failed handshakes back off 3, 6, 12 … 60 s and an open resets it', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  FakeSocket.all = [];
  const close = openLive(1, () => {});

  const waits = [];
  for (let i = 0; i < 7; i++) {
    FakeSocket.all.at(-1).drop(1006); // closed before ever opening
    waits.push(waitForNextSocket());
  }
  assert.deepEqual(waits, [3000, 6000, 12000, 24000, 48000, 60000, 60000]);

  // A socket that opened and then dropped retries after 3 s again.
  FakeSocket.all.at(-1).open();
  FakeSocket.all.at(-1).drop(1006);
  assert.equal(waitForNextSocket(), 3000);
  // ...and if that retry's handshake fails, the backoff starts over: 3 s, 6 s.
  FakeSocket.all.at(-1).drop(1006);
  assert.equal(waitForNextSocket(), 3000);
  FakeSocket.all.at(-1).drop(1006);
  assert.equal(waitForNextSocket(), 6000);
  close();
});

test('close() stops reconnecting, and 4401 ends it for good', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  FakeSocket.all = [];
  const close = openLive(1, () => {});
  const first = FakeSocket.all[0];
  close();
  assert.equal(first.closedByClient, true);
  first.drop(1000);
  assert.equal(waitForNextSocket(), Infinity);

  FakeSocket.all = [];
  openLive(2, () => {});
  FakeSocket.all[0].open();
  FakeSocket.all[0].drop(4401);
  assert.equal(waitForNextSocket(), Infinity);
});

test('delivers parsed JSON messages and ignores malformed ones', () => {
  FakeSocket.all = [];
  const got = [];
  const close = openLive(1, (m) => got.push(m));
  const socket = FakeSocket.all[0];
  socket.onmessage({ data: '{"type":"status","status":{"online":true}}' });
  socket.onmessage({ data: 'not json' });
  assert.deepEqual(got, [{ type: 'status', status: { online: true } }]);
  close();
});
