import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { serverListPing, componentToLegacy, detectSoftware } from '../src/minecraft/ping.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';

const HOST = '127.0.0.1';

function varInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function frame(packetId, payload = Buffer.alloc(0)) {
  const inner = Buffer.concat([varInt(packetId), payload]);
  return Buffer.concat([varInt(inner.length), inner]);
}

function statusFrame(json) {
  const body = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json), 'utf8');
  return frame(0, Buffer.concat([varInt(body.length), body]));
}

// A scripted server: `onConnection(socket)` decides what to send back.
async function withRawServer(onConnection, fn) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  try {
    await fn(server.address().port);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('pings the fake server', async () => {
  const fake = await startFakeMinecraft();
  try {
    const res = await serverListPing({ host: HOST, port: fake.gamePort });
    assert.equal(res.online, true);
    assert.equal(res.version, 'Paper 1.21.4');
    assert.equal(res.protocol, 769);
    assert.equal(res.software, 'Paper');
    assert.deepEqual(res.players, { online: 2, max: 20, sample: ['Steve', 'Alex'] });
    assert.equal(res.motd, 'A §aCraft');
    assert.ok(Number.isFinite(res.latencyMs) && res.latencyMs >= 0 && res.latencyMs < 1000);
  } finally {
    await fake.close();
  }
});

test('a port with no server is offline, fast', async () => {
  const fake = await startFakeMinecraft();
  await fake.setOnline(false);
  try {
    const started = Date.now();
    const res = await serverListPing({ host: HOST, port: fake.gamePort });
    assert.deepEqual(res, { online: false, error: 'ECONNREFUSED' });
    assert.ok(Date.now() - started < 3500);
  } finally {
    await fake.close();
  }
});

test('an unresolvable host is offline with ENOTFOUND', async () => {
  const res = await serverListPing({ host: 'nonexistent.invalid', timeoutMs: 2000 });
  assert.equal(res.online, false);
  // Without any DNS at all the lookup may hang until our own timeout.
  assert.ok(['ENOTFOUND', 'TIMEOUT'].includes(res.error), res.error);
});

test('a server that accepts but never answers times out within timeoutMs', async () => {
  await withRawServer(
    () => {},
    async (port) => {
      const started = Date.now();
      const res = await serverListPing({ host: HOST, port, timeoutMs: 300 });
      assert.deepEqual(res, { online: false, error: 'TIMEOUT' });
      assert.ok(Date.now() - started < 1500);
    },
  );
});

test('garbage JSON is a PROTOCOL error', async () => {
  await withRawServer(
    (socket) => socket.on('data', () => socket.write(statusFrame('not json{'))),
    async (port) => {
      assert.deepEqual(await serverListPing({ host: HOST, port }), {
        online: false,
        error: 'PROTOCOL',
      });
    },
  );
});

test('a JSON value that is not an object is a PROTOCOL error', async () => {
  await withRawServer(
    (socket) => socket.on('data', () => socket.write(statusFrame('42'))),
    async (port) => {
      assert.equal((await serverListPing({ host: HOST, port })).error, 'PROTOCOL');
    },
  );
});

test('an oversized status packet is a PROTOCOL error and the socket is dropped', async () => {
  let closed;
  const closedPromise = new Promise((resolve) => (closed = resolve));
  await withRawServer(
    (socket) => {
      socket.on('close', closed);
      socket.on('data', () => socket.write(varInt(2 * 1024 * 1024)));
    },
    async (port) => {
      assert.equal((await serverListPing({ host: HOST, port })).error, 'PROTOCOL');
      await closedPromise;
    },
  );
});

test('closing before any status is a PROTOCOL error', async () => {
  await withRawServer(
    (socket) => socket.on('data', () => socket.destroy()),
    async (port) => {
      assert.equal((await serverListPing({ host: HOST, port })).error, 'PROTOCOL');
    },
  );
});

test('a failed pong still reports the server online', async () => {
  const status = {
    version: { name: 'Purpur 1.20.4', protocol: 765 },
    players: { online: 0, max: 10 },
    description: 'Plain §bmotd',
  };
  await withRawServer(
    (socket) => {
      let answered = false;
      socket.on('data', () => {
        if (answered) return socket.destroy(); // the ping arrives: drop without pong
        answered = true;
        socket.write(statusFrame(status));
      });
    },
    async (port) => {
      const res = await serverListPing({ host: HOST, port });
      assert.equal(res.online, true);
      assert.equal(res.software, 'Purpur');
      assert.equal(res.motd, 'Plain §bmotd');
      assert.deepEqual(res.players, { online: 0, max: 10, sample: [] });
      assert.ok(res.latencyMs >= 0);
    },
  );
});

test('a pong that never arrives is bounded by timeoutMs and still online', async () => {
  await withRawServer(
    (socket) => {
      let answered = false;
      socket.on('data', () => {
        if (answered) return;
        answered = true;
        socket.write(statusFrame({ version: { name: '1.21', protocol: 767 }, description: '' }));
      });
    },
    async (port) => {
      const started = Date.now();
      const res = await serverListPing({ host: HOST, port, timeoutMs: 300 });
      assert.equal(res.online, true);
      assert.equal(res.software, 'Vanilla');
      assert.ok(Date.now() - started < 1500);
    },
  );
});

test('componentToLegacy: color goes before format codes', () => {
  assert.equal(componentToLegacy({ text: 'x', bold: true, color: 'red' }), '§c§lx');
});

test('componentToLegacy: strings pass through untouched', () => {
  assert.equal(componentToLegacy('§aHi'), '§aHi');
  assert.equal(componentToLegacy(''), '');
});

test('componentToLegacy: all named colors and formats', () => {
  const colors = {
    black: '0',
    dark_blue: '1',
    dark_green: '2',
    dark_aqua: '3',
    dark_red: '4',
    dark_purple: '5',
    gold: '6',
    gray: '7',
    dark_gray: '8',
    blue: '9',
    green: 'a',
    aqua: 'b',
    red: 'c',
    light_purple: 'd',
    yellow: 'e',
    white: 'f',
  };
  for (const [name, code] of Object.entries(colors)) {
    assert.equal(componentToLegacy({ text: 't', color: name }), `§${code}t`, name);
  }
  const formats = { obfuscated: 'k', bold: 'l', strikethrough: 'm', underlined: 'n', italic: 'o' };
  for (const [name, code] of Object.entries(formats)) {
    assert.equal(componentToLegacy({ text: 't', [name]: true }), `§${code}t`, name);
  }
});

test('componentToLegacy: hex colors', () => {
  assert.equal(componentToLegacy({ text: 'h', color: '#FF00aa' }), '§x§f§f§0§0§a§ah');
});

test('componentToLegacy: extra inherits the parent style', () => {
  const out = componentToLegacy({
    text: 'a',
    color: 'red',
    bold: true,
    extra: [{ text: 'b' }, { text: 'c', color: 'green' }],
  });
  // b keeps red+bold (no new codes); c switches color, which drops bold in-game,
  // so bold is emitted again.
  assert.equal(out, '§c§lab§a§lc');
});

test('componentToLegacy: a child dropping a style resets and re-emits what remains', () => {
  const out = componentToLegacy({
    text: 'a',
    color: 'red',
    bold: true,
    extra: [
      { text: 'b', bold: false },
      { text: 'c', color: 'white', bold: false },
    ],
  });
  assert.equal(out, '§c§la§r§cb§fc');
});

test('componentToLegacy: styled segment followed by plain text resets', () => {
  const out = componentToLegacy({ text: '', extra: [{ text: 'a', color: 'red' }, 'b'] });
  // A plain string child inherits from the (unstyled) parent, not from its sibling.
  assert.equal(out, '§ca§rb');
});

test('componentToLegacy: arrays, nested strings and non-text components', () => {
  assert.equal(componentToLegacy(['a', { text: 'b', color: 'green' }]), 'a§ab');
  assert.equal(componentToLegacy({ translate: 'chat.type.text', with: ['x'] }), '');
  assert.equal(componentToLegacy({ translate: 'k', extra: [{ text: 'z' }] }), 'z');
  assert.equal(componentToLegacy({ text: 'x', color: 'not_a_color' }), 'x');
  assert.equal(componentToLegacy(null), '');
});

test('componentToLegacy: pathological nesting does not blow the stack', () => {
  let node = { text: 'x' };
  for (let i = 0; i < 5000; i++) node = { text: '', extra: [node] };
  assert.equal(typeof componentToLegacy(node), 'string');
});

test('detectSoftware', () => {
  assert.equal(detectSoftware('Paper 1.21.4'), 'Paper');
  assert.equal(detectSoftware('paper 1.20'), 'Paper');
  assert.equal(detectSoftware('Purpur 1.20.4'), 'Purpur');
  assert.equal(detectSoftware('Purpur (Paper fork) 1.20.4'), 'Purpur');
  assert.equal(detectSoftware('Spigot 1.19'), 'Spigot');
  assert.equal(detectSoftware('Paper/Spigot 1.19'), 'Paper');
  assert.equal(detectSoftware('Fabric 1.21'), 'Fabric');
  assert.equal(detectSoftware('Forge 1.20.1'), 'Forge');
  assert.equal(detectSoftware('NeoForge 1.21'), 'Forge');
  assert.equal(detectSoftware('1.21.4'), 'Vanilla');
  assert.equal(detectSoftware(undefined), 'Vanilla');
});
