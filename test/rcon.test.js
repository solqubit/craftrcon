import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RconClient, RconError } from '../src/minecraft/rcon.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';

const never = () => new Promise(() => {});

async function withFakeBase(options, fn) {
  const fake = await startFakeMinecraft(options);
  const clients = [];
  const make = (overrides = {}) => {
    const client = new RconClient({
      host: '127.0.0.1',
      port: fake.rconPort,
      password: 'test',
      ...overrides,
    });
    clients.push(client);
    return client;
  };
  try {
    await fn(fake, make);
  } finally {
    for (const c of clients) c.close();
    await fake.close();
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof RconError, `expected RconError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });

test('closed port rejects with ECONNREFUSED', async () => {
  const port = await freePort();
  const client = new RconClient({ host: '127.0.0.1', port, password: 'test' });
  await rejectsWith(client.connect(), 'ECONNREFUSED');
});

test('unresolvable host rejects with ENOTFOUND', async () => {
  const client = new RconClient({ host: 'no-such-host.invalid', port: 25575, password: 'x' });
  await assert.rejects(client.connect(), (err) => {
    assert.ok(err instanceof RconError);
    assert.ok(['ENOTFOUND', 'TIMEOUT'].includes(err.code), err.code);
    return true;
  });
});

test('exec before connect rejects with CLOSED', async () => {
  const client = new RconClient({ host: '127.0.0.1', port: 1, password: 'x' });
  await rejectsWith(client.exec('list'), 'CLOSED');
});

test('connect times out when the peer accepts TCP but never answers auth', async () => {
  const sockets = new Set();
  const silent = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RconClient({
      host: '127.0.0.1',
      port: silent.address().port,
      password: 'test',
      timeoutMs: 250,
    });
    const started = Date.now();
    await rejectsWith(client.connect(), 'TIMEOUT');
    assert.ok(Date.now() - started < 250 + 200);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
});

// Every scenario below runs against the lenient fake and against the strict
// (vanilla-like) fake, which closes the connection unless each read is one packet.
for (const strict of [false, true]) {
  const label = strict ? '[strict] ' : '';
  const withFake = (options, fn) => withFakeBase({ ...options, strict }, fn);

  test(`${label}exec returns the default command output`, async () => {
    await withFake({}, async (_fake, make) => {
      const client = make();
      await client.connect();
      assert.equal(
        await client.exec('list'),
        'There are 2 of a max of 20 players online: Steve, Alex',
      );
    });
  });

  test(`${label}several commands run one after another on one connection`, async () => {
    await withFake({}, async (_fake, make) => {
      const client = make();
      await client.connect();
      assert.equal(await client.exec('banlist'), 'There are no bans');
      assert.equal(await client.exec('say hi'), '');
      assert.match(await client.exec('tps'), /TPS from last/);
    });
  });

  test(`${label}wrong password rejects with AUTH_FAILED`, async () => {
    await withFake({}, async (_fake, make) => {
      await rejectsWith(make({ password: 'nope' }).connect(), 'AUTH_FAILED');
    });
  });

  test(`${label}multi-byte characters split across packets are decoded intact`, async () => {
    const text = '¡Hola, señores! ' + 'ñ'.repeat(300);
    await withFake({ split: true, handlers: { big: () => text } }, async (_fake, make) => {
      const client = make();
      await client.connect();
      assert.equal(await client.exec('big'), text);
    });
  });

  test(`${label}a 100-byte packet boundary inside a multi-byte character is decoded intact`, async () => {
    // The fake cuts responses every 100 bytes. 'a' shifts every 2-byte 'ñ' to an
    // odd offset, so the cut between bytes 99 and 100 lands inside a character.
    const text = 'a' + 'ñ'.repeat(300);
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(bytes[100] & 0xc0, 0x80, 'byte 100 must be a UTF-8 continuation byte');
    await withFake({ split: true, handlers: { big: () => text } }, async (_fake, make) => {
      const client = make();
      await client.connect();
      assert.equal(await client.exec('big'), text);
    });
  });

  test(`${label}a 4-byte emoji split across packets is decoded intact`, async () => {
    const text = 'abc' + '😀'.repeat(100);
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(bytes[100] & 0xc0, 0x80, 'byte 100 must be a UTF-8 continuation byte');
    await withFake({ split: true, handlers: { big: () => text } }, async (_fake, make) => {
      const client = make();
      await client.connect();
      assert.equal(await client.exec('big'), text);
    });
  });

  test(`${label}a handler that never answers rejects with TIMEOUT in time, then the client closes`, async () => {
    await withFake({ handlers: { hang: never } }, async (_fake, make) => {
      const client = make({ timeoutMs: 300 });
      await client.connect();
      let closed = 0;
      client.on('close', () => closed++);
      const started = Date.now();
      await rejectsWith(client.exec('hang'), 'TIMEOUT');
      assert.ok(Date.now() - started < 300 + 200, 'timeout must fire before timeoutMs + 200');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closed, 1);
      await rejectsWith(client.exec('list'), 'CLOSED');
    });
  });

  test(`${label}a client can reconnect after a TIMEOUT and gets clean answers`, async () => {
    await withFake({ handlers: { hang: never } }, async (_fake, make) => {
      const client = make({ timeoutMs: 200 });
      await client.connect();
      await rejectsWith(client.exec('hang'), 'TIMEOUT');
      await client.connect();
      assert.equal(await client.exec('banlist'), 'There are no bans');
    });
  });

  test(`${label}exec sends the command as UTF-8`, async () => {
    await withFake({}, async (fake, make) => {
      const client = make();
      await client.connect();
      await client.exec('say ¡Hola!');
      assert.deepEqual(fake.received, ['say ¡Hola!']);
    });
  });

  test(`${label}exec after close rejects with CLOSED and close emits once`, async () => {
    await withFake({}, async (_fake, make) => {
      const client = make();
      await client.connect();
      let closed = 0;
      client.on('close', () => closed++);
      client.close();
      client.close();
      assert.equal(closed, 1);
      await rejectsWith(client.exec('list'), 'CLOSED');
    });
  });

  test(`${label}connect() right after close() starts a fresh connection`, async () => {
    await withFake({}, async (_fake, make) => {
      const client = make();
      await client.connect();
      client.close();
      await client.connect();
      assert.match(await client.exec('list'), /players online/);
    });
  });

  test(`${label}close() during connect fails that attempt and a following connect() starts afresh`, async () => {
    await withFake({}, async (_fake, make) => {
      const client = make();
      const first = client.connect();
      client.close();
      const second = client.connect(); // same tick: must not reuse the rejected attempt
      await rejectsWith(first, 'CLOSED');
      await second;
      assert.match(await client.exec('list'), /players online/);
    });
  });

  test(`${label}a dropped connection fails the in-flight command with CLOSED and emits close`, async () => {
    await withFake({ handlers: { slow: never } }, async (fake, make) => {
      const client = make();
      await client.connect();
      const closed = new Promise((resolve) => client.once('close', resolve));
      const pending = client.exec('slow');
      setTimeout(() => fake.dropConnections(), 50);
      await rejectsWith(pending, 'CLOSED');
      await closed;
      await rejectsWith(client.exec('list'), 'CLOSED');
    });
  });

  test(`${label}the same client reconnects after the server restarts`, async () => {
    await withFake({}, async (fake, make) => {
      const client = make();
      await client.connect();
      await fake.setOnline(false);
      await rejectsWith(client.exec('list'), 'CLOSED');
      await rejectsWith(client.connect(), 'ECONNREFUSED');
      await fake.setOnline(true);
      await client.connect();
      assert.match(await client.exec('list'), /players online/);
    });
  });

  test(`${label}concurrent exec on one client is rejected with a clear error`, async () => {
    await withFake({ handlers: { slow: () => new Promise((r) => setTimeout(() => r('done'), 100)) } }, async (_fake, make) => {
      const client = make();
      await client.connect();
      const first = client.exec('slow');
      await assert.rejects(client.exec('list'), /concurrent/i);
      assert.equal(await first, 'done');
    });
  });
}

// --- vanilla framing (strict fake and hand-rolled peers) ---

function rawPacket(id, type, body = '') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + bytes.length);
  out.writeInt32LE(10 + bytes.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  bytes.copy(out, 12);
  return out;
}

// A scripted RCON peer: `onPacket(packet, socket, chunk)` sees every packet the
// client sends (auth is answered automatically) together with the raw chunk.
async function startScriptedPeer(onPacket) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      const packet = {
        length: chunk.readInt32LE(0),
        id: chunk.readInt32LE(4),
        type: chunk.readInt32LE(8),
        body: chunk.toString('utf8', 12, chunk.length - 2),
      };
      if (packet.type === 3) socket.write(rawPacket(packet.id, 2));
      else onPacket(packet, socket, chunk);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('[strict] responses longer than 4096 bytes arrive in fragments and are joined', async () => {
  const text = 'line of help text\n'.repeat(700); // ~12.6 KB: four fragments
  await withFakeBase({ strict: true, handlers: { help: () => text } }, async (fake, make) => {
    const client = make();
    await client.connect();
    assert.equal(await client.exec('help'), text);
    assert.equal(await client.exec('list'), 'There are 2 of a max of 20 players online: Steve, Alex');
    assert.equal(fake.stats.violations, 0);
  });
});

test('[strict] a 2-byte character cut by the 4096-byte fragment boundary is decoded intact', async () => {
  const text = 'a' + 'ñ'.repeat(5000);
  assert.equal(Buffer.from(text, 'utf8')[4096] & 0xc0, 0x80, 'byte 4096 must be a continuation byte');
  await withFakeBase({ strict: true, handlers: { big: () => text } }, async (_fake, make) => {
    const client = make();
    await client.connect();
    assert.equal(await client.exec('big'), text);
  });
});

test('[strict] a 4-byte emoji cut by the 4096-byte fragment boundary is decoded intact', async () => {
  const text = 'abc' + '😀'.repeat(2000);
  assert.equal(Buffer.from(text, 'utf8')[4096] & 0xc0, 0x80, 'byte 4096 must be a continuation byte');
  await withFakeBase({ strict: true, handlers: { big: () => text } }, async (_fake, make) => {
    const client = make();
    await client.connect();
    assert.equal(await client.exec('big'), text);
  });
});

test('[strict] without a sentinel answer the response completes after the grace period', async () => {
  const text = 'x'.repeat(9000);
  const handlers = { big: () => text };
  await withFakeBase({ strict: true, ignoreSentinel: true, handlers }, async (fake, make) => {
    const client = make({ timeoutMs: 3000 });
    await client.connect();
    const started = Date.now();
    assert.equal(await client.exec('list'), 'There are 2 of a max of 20 players online: Steve, Alex');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 200 && elapsed < 1500, `completed after ${elapsed} ms`);
    assert.equal(await client.exec('big'), text); // multi-fragment, joined
    assert.equal(await client.exec('say hi'), ''); // empty body still completes
    assert.deepEqual(fake.received, ['list', 'big', 'say hi']);
    assert.equal(fake.stats.violations, 0);
  });
});

test('the sentinel is written alone, only after the first response packet', async () => {
  const writes = [];
  const peer = await startScriptedPeer((packet, socket, chunk) => {
    writes.push({ ...packet, bytes: chunk.length });
    if (packet.type === 2) {
      // Answer late: nothing else may arrive from the client meanwhile.
      setTimeout(() => socket.write(rawPacket(packet.id, 0, 'pong')), 100);
    } else {
      socket.write(rawPacket(packet.id, 0, 'Unknown request 0'));
    }
  });
  const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'x' });
  try {
    await client.connect();
    assert.equal(await client.exec('ping'), 'pong');
    assert.deepEqual(
      writes.map(({ id, type, length, bytes }) => ({ id, type, single: length === bytes - 4 })),
      [
        { id: 3, type: 2, single: true },
        { id: 4, type: 0, single: true },
      ],
    );
  } finally {
    client.close();
    await peer.close();
  }
});

test('once the server has answered a sentinel, a slow fragment is not cut off by the grace period', async () => {
  // Like vanilla, the peer answers a sentinel only after the whole response.
  let responseDone = Promise.resolve();
  const peer = await startScriptedPeer((packet, socket) => {
    if (packet.type === 0) {
      responseDone.then(() => socket.write(rawPacket(packet.id, 0, 'Unknown request 0')));
    } else if (packet.body === 'slow') {
      socket.write(rawPacket(packet.id, 0, 'first half, '));
      responseDone = new Promise((resolve) =>
        setTimeout(() => {
          socket.write(rawPacket(packet.id, 0, 'second half'));
          resolve();
        }, 400),
      );
    } else {
      socket.write(rawPacket(packet.id, 0, 'ok'));
    }
  });
  const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'x', sentinelGraceMs: 100 });
  try {
    await client.connect();
    assert.equal(await client.exec('fast'), 'ok'); // the server answers sentinels
    assert.equal(await client.exec('slow'), 'first half, second half');
  } finally {
    client.close();
    await peer.close();
  }
});
