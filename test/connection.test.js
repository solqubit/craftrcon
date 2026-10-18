import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RconError } from '../src/minecraft/rcon.js';
import { ServerConnection, ConnectionManager } from '../src/minecraft/connection.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

// Manual clock so backoff tests never sleep.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function withFakeBase(options, fn) {
  const fake = await startFakeMinecraft(options);
  const conns = [];
  const make = (overrides = {}) => {
    const conn = new ServerConnection({
      host: '127.0.0.1',
      port: fake.rconPort,
      password: 'test',
      ...overrides,
    });
    conns.push(conn);
    return conn;
  };
  try {
    await fn(fake, make);
  } finally {
    for (const c of conns) c.close();
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

// A listener that counts connection attempts and hangs up on each one, so a
// connect() against it fails and the count shows whether an attempt was made.
async function startHangupServer() {
  const sockets = new Set();
  const stats = { attempts: 0 };
  const server = net.createServer((socket) => {
    stats.attempts += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    stats,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof RconError, `expected RconError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });

test('connect failure: state error, exec fails fast with the last error code during backoff', async () => {
  const port = await freePort();
  const clock = fakeClock();
  const conn = new ServerConnection({ host: '127.0.0.1', port, password: 'x', now: clock.now });
  await rejectsWith(conn.exec('list'), 'ECONNREFUSED');
  assert.equal(conn.state, 'error');
  await rejectsWith(conn.exec('list'), 'ECONNREFUSED'); // fast fail, same code
  clock.advance(1000);
  assert.equal(conn.state, 'idle'); // backoff over, will try again
  conn.close();
});

test('backoff schedule: 1, 2, 4, 8, 16, 30, 30 seconds', async () => {
  const server = await startHangupServer();
  const clock = fakeClock();
  const conn = new ServerConnection({
    host: '127.0.0.1',
    port: server.port,
    password: 'x',
    now: clock.now,
  });
  try {
    let expectedAttempts = 0;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await rejectsWith(conn.exec('list'), 'CLOSED'); // a real attempt
      expectedAttempts += 1;
      assert.equal(server.stats.attempts, expectedAttempts);
      clock.advance(delay - 1);
      await rejectsWith(conn.exec('list'), 'CLOSED'); // still backing off
      assert.equal(server.stats.attempts, expectedAttempts, `attempt before ${delay} ms`);
      clock.advance(1); // delay elapsed: the next exec attempts again
    }
  } finally {
    conn.close();
    await server.close();
  }
});

test('manager: unknown server throws NOT_FOUND (sync and async resolvers)', async () => {
  const syncManager = new ConnectionManager(() => null);
  assert.throws(
    () => syncManager.get(1),
    (err) => err.code === 'NOT_FOUND',
  );

  let found = false;
  const asyncManager = new ConnectionManager(async () => (found ? { host: '127.0.0.1', rcon_port: 1, password: 'x' } : undefined));
  const conn = asyncManager.get(1);
  await assert.rejects(conn.exec('list'), (err) => err.code === 'NOT_FOUND');
  // The failed entry is forgotten, so a later get resolves again.
  await sleep(0);
  found = true;
  assert.notEqual(asyncManager.get(1), conn);
  asyncManager.closeAll();
});

// Every scenario below runs against the lenient fake and against the strict
// (vanilla-like) fake, which closes the connection unless each read is one packet.
for (const strict of [false, true]) {
  const label = strict ? '[strict] ' : '';
  const withFake = (options, fn) => withFakeBase({ ...options, strict }, fn);

  test(`${label}10 concurrent execs: each promise gets its own answer, fake receives them in order`, async () => {
    const handlers = {
      echo: async (args) => {
        await sleep(Math.floor(Math.random() * 30));
        return `echo:${args}`;
      },
    };
    await withFake({ handlers }, async (fake, make) => {
      const conn = make();
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => conn.exec(`echo ${i}`)));
      assert.deepEqual(
        results,
        Array.from({ length: 10 }, (_, i) => `echo:${i}`),
      );
      assert.deepEqual(
        fake.received,
        Array.from({ length: 10 }, (_, i) => `echo ${i}`),
      );
      assert.equal(conn.state, 'ready');
    });
  });

  test(`${label}commands are strictly serialized: never two in flight on the fake`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const handlers = {
      work: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight -= 1;
        return 'done';
      },
    };
    await withFake({ handlers }, async (_fake, make) => {
      const conn = make();
      await Promise.all(Array.from({ length: 6 }, () => conn.exec('work')));
      assert.equal(maxInFlight, 1);
    });
  });

  test(`${label}state goes idle -> ready, and back to idle on close()`, async () => {
    await withFake({}, async (_fake, make) => {
      const conn = make();
      assert.equal(conn.state, 'idle');
      const pending = conn.exec('list');
      assert.equal(conn.state, 'connecting');
      await pending;
      assert.equal(conn.state, 'ready');
      conn.close();
      assert.equal(conn.state, 'idle');
    });
  });

  test(`${label}in-flight command fails with CLOSED when the connection drops; the next exec reconnects`, async () => {
    const handlers = { slow: async () => sleep(300).then(() => 'late') };
    await withFake({ handlers }, async (fake, make) => {
      const conn = make();
      assert.match(await conn.exec('list'), /players online/);
      const inFlight = conn.exec('slow');
      const queued = conn.exec('list'); // waits behind the in-flight command
      while (!fake.received.includes('slow')) await sleep(5);
      fake.dropConnections();
      await rejectsWith(inFlight, 'CLOSED');
      // The queued command reconnects on its own, with no backoff after a drop.
      assert.match(await queued, /players online/);
      assert.match(await conn.exec('list'), /players online/);
    });
  });

  test(`${label}server restart mid-session: in-flight fails, next exec reconnects`, async () => {
    const handlers = { slow: async () => sleep(300).then(() => 'late') };
    await withFake({ handlers }, async (fake, make) => {
      const conn = make();
      await conn.exec('list');
      const inFlight = conn.exec('slow');
      while (!fake.received.includes('slow')) await sleep(5);
      await fake.setOnline(false);
      await rejectsWith(inFlight, 'CLOSED');
      await fake.setOnline(true);
      assert.match(await conn.exec('list'), /players online/);
    });
  });

  test(`${label}a command TIMEOUT does not start backoff: the next exec reconnects immediately`, async () => {
    await withFake({ handlers: { hang: never } }, async (_fake, make) => {
      const conn = make({ timeoutMs: 100 });
      await rejectsWith(conn.exec('hang'), 'TIMEOUT');
      assert.equal(conn.state, 'idle');
      assert.match(await conn.exec('list'), /players online/);
    });
  });

  test(`${label}multi-byte text is sent intact twice over the same connection`, async () => {
    const handlers = { say: (args) => args };
    await withFake({ handlers }, async (fake, make) => {
      const conn = make();
      assert.equal(await conn.exec('say ¡Hola, señores!'), '¡Hola, señores!');
      assert.equal(await conn.exec('say ¡Hola, señores!'), '¡Hola, señores!');
      assert.deepEqual(fake.received, ['say ¡Hola, señores!', 'say ¡Hola, señores!']);
    });
  });

  test(`${label}backoff: no connection attempt before the delay, then retry succeeds and resets`, async () => {
    const fake = await startFakeMinecraft({ strict });
    const clock = fakeClock();
    const conn = new ServerConnection({
      host: '127.0.0.1',
      port: fake.rconPort,
      password: 'test',
      now: clock.now,
    });
    try {
      await fake.setOnline(false);
      await rejectsWith(conn.exec('list'), 'ECONNREFUSED');
      await fake.setOnline(true); // up again, but we are still inside the 1 s backoff
      clock.advance(999);
      await rejectsWith(conn.exec('list'), 'ECONNREFUSED');
      assert.deepEqual(fake.received, []);
      clock.advance(1);
      assert.match(await conn.exec('list'), /players online/);
      assert.equal(conn.state, 'ready');
    } finally {
      conn.close();
      await fake.close();
    }
  });

  test(`${label}a successful connect resets the backoff`, async () => {
    const fake = await startFakeMinecraft({ strict });
    const clock = fakeClock();
    const conn = new ServerConnection({
      host: '127.0.0.1',
      port: fake.rconPort,
      password: 'test',
      now: clock.now,
    });
    try {
      await fake.setOnline(false);
      await rejectsWith(conn.exec('list'), 'ECONNREFUSED'); // 1 s
      clock.advance(1000);
      await rejectsWith(conn.exec('list'), 'ECONNREFUSED'); // 2 s
      clock.advance(2000);
      await fake.setOnline(true);
      await conn.exec('list'); // success resets
      await fake.setOnline(false); // drop + offline
      for (let i = 0; conn.state !== 'idle'; i++) {
        assert.ok(i < 500, 'client never noticed the drop');
        await sleep(2); // client noticed the drop
      }
      await rejectsWith(conn.exec('list'), 'ECONNREFUSED'); // first failure again: 1 s, not 4 s
      await fake.setOnline(true);
      clock.advance(1000);
      assert.match(await conn.exec('list'), /players online/);
    } finally {
      conn.close();
      await fake.close();
    }
  });

  test(`${label}AUTH_FAILED also starts backoff and is reported on fast failures`, async () => {
    const fake = await startFakeMinecraft({ strict, password: 'right' });
    const clock = fakeClock();
    const conn = new ServerConnection({
      host: '127.0.0.1',
      port: fake.rconPort,
      password: 'wrong',
      now: clock.now,
    });
    try {
      await rejectsWith(conn.exec('list'), 'AUTH_FAILED');
      assert.equal(conn.state, 'error');
      await rejectsWith(conn.exec('list'), 'AUTH_FAILED');
    } finally {
      conn.close();
      await fake.close();
    }
  });

  test(`${label}close() rejects queued commands with CLOSED; a later exec reconnects`, async () => {
    const handlers = { slow: async () => sleep(100).then(() => 'slow done') };
    await withFake({ handlers }, async (fake, make) => {
      const conn = make();
      await conn.exec('list');
      const running = conn.exec('slow');
      const queued = conn.exec('list');
      while (!fake.received.includes('slow')) await sleep(5);
      conn.close();
      await rejectsWith(running, 'CLOSED');
      await rejectsWith(queued, 'CLOSED');
      assert.equal(conn.state, 'idle');
      assert.match(await conn.exec('list'), /players online/);
    });
  });

  // Regression: the connection is torn down right after the auth response resolves
  // connect(). The ServerConnection must not stay "ready" with no socket.
  test(`${label}a connection torn down right after auth does not get stuck in ready`, async () => {
    const fake = await startFakeMinecraft({ strict });
    const sockets = new Set();
    const stats = { attempts: 0 };
    const proxy = net.createServer((client) => {
      stats.attempts += 1;
      sockets.add(client);
      client.on('error', () => {});
      client.on('close', () => sockets.delete(client));
      if (stats.attempts > 1) {
        const upstream = net.connect(fake.rconPort, '127.0.0.1');
        sockets.add(upstream);
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
        return;
      }
      // First attempt: auth OK plus an invalid packet (length 3) in the same chunk.
      client.once('data', (chunk) => {
        const authOk = Buffer.alloc(14);
        authOk.writeInt32LE(10, 0);
        authOk.writeInt32LE(chunk.readInt32LE(4), 4);
        authOk.writeInt32LE(2, 8);
        const bad = Buffer.alloc(4);
        bad.writeInt32LE(3, 0);
        client.write(Buffer.concat([authOk, bad]));
      });
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const conn = new ServerConnection({
      host: '127.0.0.1',
      port: proxy.address().port,
      password: 'test',
    });
    try {
      await rejectsWith(conn.exec('list'), 'CLOSED');
      assert.notEqual(conn.state, 'ready');
      assert.match(await conn.exec('list'), /players online/);
      assert.ok(stats.attempts >= 2, 'a later exec must open a new connection');
      assert.equal(conn.state, 'ready');
    } finally {
      conn.close();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      await fake.close();
    }
  });

  test(`${label}close() while connecting does not start backoff`, async () => {
    await withFake({}, async (_fake, make) => {
      const conn = make();
      const first = conn.exec('list');
      conn.close();
      await rejectsWith(first, 'CLOSED');
      assert.equal(conn.state, 'idle');
      assert.match(await conn.exec('list'), /players online/);
    });
  });

  // --- ConnectionManager ---

  test(`${label}manager.get is lazy, cached and maps rcon_port; resolveServer is called once`, async () => {
    await withFake({}, async (fake) => {
      let calls = 0;
      const manager = new ConnectionManager((id) => {
        calls += 1;
        assert.equal(id, 7);
        return { host: '127.0.0.1', rcon_port: fake.rconPort, password: 'test' };
      });
      try {
        assert.equal(calls, 0);
        const a = manager.get(7);
        assert.ok(a instanceof ServerConnection);
        assert.equal(manager.get(7), a);
        assert.equal(calls, 1);
        assert.match(await a.exec('list'), /players online/);
      } finally {
        manager.closeAll();
      }
    });
  });

  test(`${label}manager.invalidate closes and forgets: the next get returns a new instance`, async () => {
    await withFake({}, async (fake) => {
      let calls = 0;
      const manager = new ConnectionManager(() => {
        calls += 1;
        return { host: '127.0.0.1', rcon_port: fake.rconPort, password: 'test' };
      });
      try {
        const a = manager.get(1);
        await a.exec('list');
        manager.invalidate(1);
        assert.equal(a.state, 'idle');
        const b = manager.get(1);
        assert.notEqual(b, a);
        assert.equal(calls, 2);
        assert.match(await b.exec('list'), /players online/);
        manager.invalidate(99); // unknown id: no-op
      } finally {
        manager.closeAll();
      }
    });
  });

  test(`${label}manager supports an async resolveServer`, async () => {
    await withFake({}, async (fake) => {
      let calls = 0;
      const manager = new ConnectionManager(async () => {
        calls += 1;
        await sleep(10);
        return { host: '127.0.0.1', rcon_port: fake.rconPort, password: 'test' };
      });
      try {
        const conn = manager.get(1);
        assert.equal(manager.get(1), conn);
        assert.match(await conn.exec('list'), /players online/);
        assert.equal(calls, 1);
      } finally {
        manager.closeAll();
      }
    });
  });

  test(`${label}manager.closeAll closes every connection and forgets them`, async () => {
    await withFake({}, async (fake) => {
      const manager = new ConnectionManager(() => ({
        host: '127.0.0.1',
        rcon_port: fake.rconPort,
        password: 'test',
      }));
      const a = manager.get(1);
      const b = manager.get(2);
      await Promise.all([a.exec('list'), b.exec('list')]);
      manager.closeAll();
      assert.equal(a.state, 'idle');
      assert.equal(b.state, 'idle');
      assert.notEqual(manager.get(1), a);
      manager.closeAll();
    });
  });
}
