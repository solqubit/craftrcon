import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RconClient, RconError } from '../src/minecraft/rcon.js';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';

const never = () => new Promise(() => {});

async function withFake(options, fn) {
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

test('exec returns the default command output', async () => {
  await withFake({}, async (_fake, make) => {
    const client = make();
    await client.connect();
    assert.equal(
      await client.exec('list'),
      'There are 2 of a max of 20 players online: Steve, Alex',
    );
  });
});

test('several commands run one after another on one connection', async () => {
  await withFake({}, async (_fake, make) => {
    const client = make();
    await client.connect();
    assert.equal(await client.exec('banlist'), 'There are no bans');
    assert.equal(await client.exec('say hi'), '');
    assert.match(await client.exec('tps'), /TPS from last/);
  });
});

test('wrong password rejects with AUTH_FAILED', async () => {
  await withFake({}, async (_fake, make) => {
    await rejectsWith(make({ password: 'nope' }).connect(), 'AUTH_FAILED');
  });
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

test('multi-byte characters split across packets are decoded intact', async () => {
  const text = '¡Hola, señores! ' + 'ñ'.repeat(300);
  await withFake({ split: true, handlers: { big: () => text } }, async (_fake, make) => {
    const client = make();
    await client.connect();
    assert.equal(await client.exec('big'), text);
  });
});

test('a handler that never answers rejects with TIMEOUT in time, then the client closes', async () => {
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

test('a client can reconnect after a TIMEOUT and gets clean answers', async () => {
  await withFake({ handlers: { hang: never } }, async (_fake, make) => {
    const client = make({ timeoutMs: 200 });
    await client.connect();
    await rejectsWith(client.exec('hang'), 'TIMEOUT');
    await client.connect();
    assert.equal(await client.exec('banlist'), 'There are no bans');
  });
});

test('exec sends the command as UTF-8', async () => {
  await withFake({}, async (fake, make) => {
    const client = make();
    await client.connect();
    await client.exec('say ¡Hola!');
    assert.deepEqual(fake.received, ['say ¡Hola!']);
  });
});

test('exec before connect rejects with CLOSED', async () => {
  const client = new RconClient({ host: '127.0.0.1', port: 1, password: 'x' });
  await rejectsWith(client.exec('list'), 'CLOSED');
});

test('exec after close rejects with CLOSED and close emits once', async () => {
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

test('a dropped connection fails the in-flight command with CLOSED and emits close', async () => {
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

test('the same client reconnects after the server restarts', async () => {
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

test('concurrent exec on one client is rejected with a clear error', async () => {
  await withFake({ handlers: { slow: () => new Promise((r) => setTimeout(() => r('done'), 100)) } }, async (_fake, make) => {
    const client = make();
    await client.connect();
    const first = client.exec('slow');
    await assert.rejects(client.exec('list'), /concurrent/i);
    assert.equal(await first, 'done');
  });
});
