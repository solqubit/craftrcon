import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFakeMinecraft } from './fixtures/fakeMinecraft.js';

const AUTH = 3;
const EXEC = 2;
const VALUE = 0;

// Independent, minimal RCON packet codec so the fixture is not tested with itself.
function pkt(id, type, body = '') {
  const bytes = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + bytes.length);
  out.writeInt32LE(10 + bytes.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  bytes.copy(out, 12);
  return out;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

// Wraps a socket and hands out whole packets one at a time.
function rconClient(socket) {
  let buf = Buffer.alloc(0);
  const packets = [];
  const waiters = [];
  let ended = false;
  const flush = () => {
    while (packets.length && waiters.length) waiters.shift().resolve(packets.shift());
    if (ended) while (waiters.length) waiters.shift().reject(new Error('socket closed'));
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
      const length = buf.readInt32LE(0);
      packets.push({
        id: buf.readInt32LE(4),
        type: buf.readInt32LE(8),
        bytes: buf.subarray(12, 4 + length - 2),
        get body() {
          return this.bytes.toString('utf8');
        },
      });
      buf = buf.subarray(4 + length);
    }
    flush();
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    ended = true;
    flush();
  });
  return {
    socket,
    send: (id, type, body) => socket.write(pkt(id, type, body)),
    next: () => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); flush(); }),
  };
}

async function setup(t, opts) {
  const fake = await startFakeMinecraft(opts);
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.socket.destroy();
    await fake.close();
  });
  const open = async (login = true) => {
    const c = rconClient(await connect(fake.rconPort));
    clients.push(c);
    if (login) {
      c.send(1, AUTH, opts?.password ?? 'test');
      assert.equal((await c.next()).id, 1);
    }
    return c;
  };
  return { fake, open };
}

test('auth with the right password echoes the request id as a type 2 packet', async (t) => {
  const { open } = await setup(t);
  const c = await open(false);
  c.send(42, AUTH, 'test');
  const res = await c.next();
  assert.equal(res.id, 42);
  assert.equal(res.type, 2);
});

test('auth with a wrong password answers id -1', async (t) => {
  const { open } = await setup(t);
  const c = await open(false);
  c.send(42, AUTH, 'nope');
  const res = await c.next();
  assert.equal(res.id, -1);
  assert.equal(res.type, 2);
});

test('commands before auth are refused and not recorded', async (t) => {
  const { fake, open } = await setup(t);
  const c = await open(false);
  c.send(7, EXEC, 'list');
  assert.equal((await c.next()).id, -1);
  assert.deepEqual(fake.received, []);
});

test('default handlers imitate Paper 1.21', async (t) => {
  const { fake, open } = await setup(t, { password: 'pw' });
  const c = await open();
  const run = async (id, cmd) => {
    c.send(id, EXEC, cmd);
    const res = await c.next();
    assert.equal(res.id, id);
    assert.equal(res.type, VALUE);
    return res.body;
  };
  assert.equal(await run(2, 'list'), 'There are 2 of a max of 20 players online: Steve, Alex');
  assert.equal(await run(3, 'tps'), '§6TPS from last 1m, 5m, 15m: §a20.0, §a*20.0, §a19.97');
  assert.match(await run(4, 'banlist'), /no bans/);
  assert.match(await run(5, 'whitelist list'), /whitelisted players: Steve, Alex/);
  assert.match(await run(6, 'gamerule keepInventory'), /keepInventory is currently set to/);
  assert.equal(await run(7, 'say hola'), '');
  assert.match(await run(8, 'frobnicate now'), /^Unknown or incomplete command/);
  assert.deepEqual(fake.received, [
    'list', 'tps', 'banlist', 'whitelist list', 'gamerule keepInventory', 'say hola', 'frobnicate now',
  ]);
});

test('custom handlers get the arguments; async handlers are awaited', async (t) => {
  const seen = [];
  const { open } = await setup(t, {
    handlers: {
      echo: (args) => { seen.push(args); return `got ${args}`; },
      slow: async () => { await new Promise((r) => setTimeout(r, 20)); return 'done'; },
      list: () => 'overridden',
    },
  });
  const c = await open();
  c.send(2, EXEC, 'echo ¡Hola, señores!');
  assert.equal((await c.next()).body, 'got ¡Hola, señores!');
  assert.deepEqual(seen, ['¡Hola, señores!']);
  c.send(3, EXEC, 'slow');
  assert.equal((await c.next()).body, 'done');
  c.send(4, EXEC, 'list');
  assert.equal((await c.next()).body, 'overridden');
});

test('empty type-0 sentinel is echoed with the same id and an empty body, in order', async (t) => {
  const { fake, open } = await setup(t, {
    handlers: { slow: async () => { await new Promise((r) => setTimeout(r, 20)); return 'late'; } },
  });
  const c = await open();
  c.send(10, EXEC, 'slow');
  c.send(11, VALUE, '');
  const a = await c.next();
  const b = await c.next();
  assert.deepEqual([a.id, a.body], [10, 'late']);
  assert.deepEqual([b.id, b.type, b.body], [11, VALUE, '']);
  assert.deepEqual(fake.received, ['slow']);
});

// --- strict (vanilla-like) mode ---

test('strict: a command and its sentinel in one write close the connection, like vanilla', async (t) => {
  // This is how the RCON client used to send every command (review finding C1).
  const { fake, open } = await setup(t, { strict: true });
  const c = await open();
  c.socket.write(Buffer.concat([pkt(2, EXEC, 'list'), pkt(3, VALUE)]));
  await assert.rejects(c.next(), /socket closed/);
  assert.deepEqual(fake.received, []);
  assert.equal(fake.stats.violations, 1);
});

test('strict: a packet cut across two writes closes the connection', async (t) => {
  const { fake, open } = await setup(t, { strict: true });
  const c = await open();
  const wire = pkt(2, EXEC, 'list');
  c.socket.write(wire.subarray(0, 6));
  await new Promise((r) => setTimeout(r, 20));
  c.socket.write(wire.subarray(6));
  await assert.rejects(c.next(), /socket closed/);
  assert.deepEqual(fake.received, []);
  assert.equal(fake.stats.violations, 1);
});

test('strict: one packet per write works; the sentinel gets "Unknown request 0" with its id', async (t) => {
  const { fake, open } = await setup(t, { strict: true });
  const c = await open();
  c.send(2, EXEC, 'list');
  const res = await c.next();
  assert.deepEqual([res.id, res.type], [2, VALUE]);
  assert.match(res.body, /players online/);
  c.send(3, VALUE, '');
  const end = await c.next();
  assert.deepEqual([end.id, end.type, end.body], [3, VALUE, 'Unknown request 0']);
  assert.deepEqual(fake.received, ['list']);
  assert.equal(fake.stats.violations, 0);
});

test('strict: long bodies go out in 4096-byte fragments', async (t) => {
  const body = 'x'.repeat(4096 * 2 + 10);
  const { open } = await setup(t, { strict: true, handlers: { big: () => body } });
  const c = await open();
  c.send(2, EXEC, 'big');
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const p = await c.next();
    assert.deepEqual([p.id, p.type], [2, VALUE]);
    sizes.push(p.bytes.length);
  }
  assert.deepEqual(sizes, [4096, 4096, 10]);
});

test('strict + ignoreSentinel: type-0 packets get no answer', async (t) => {
  const { open } = await setup(t, { strict: true, ignoreSentinel: true });
  const c = await open();
  c.send(2, EXEC, 'list');
  assert.equal((await c.next()).id, 2);
  c.send(3, VALUE, '');
  await new Promise((r) => setTimeout(r, 20));
  c.send(4, EXEC, 'banlist');
  assert.equal((await c.next()).id, 4); // nothing for id 3 came first
});

test('parses packets coalesced in one chunk and fragmented byte by byte', async (t) => {
  const { fake, open } = await setup(t);
  const c = await open();
  c.socket.write(Buffer.concat([pkt(20, EXEC, 'list'), pkt(21, VALUE), pkt(22, EXEC, 'tps')]));
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await c.next()).id);
  assert.deepEqual(ids, [20, 21, 22]);
  // Fragmented: one byte per write, awaiting the event loop between writes.
  const wire = pkt(30, EXEC, 'say ñ');
  for (const byte of wire) {
    c.socket.write(Buffer.from([byte]));
    await new Promise((r) => setImmediate(r));
  }
  assert.equal((await c.next()).id, 30);
  assert.deepEqual(fake.received.slice(-1), ['say ñ']);
});

test('split: true cuts bodies into 100-byte packets, even mid UTF-8 character', async (t) => {
  // 99 ASCII bytes then a 2-byte "ñ": the character straddles bytes 100/101.
  const body = `${'a'.repeat(99)}ñ${'b'.repeat(120)}`;
  const { open } = await setup(t, { split: true, handlers: { big: () => body } });
  const c = await open();
  c.send(5, EXEC, 'big');
  const total = Buffer.byteLength(body);
  const chunks = [];
  while (chunks.reduce((n, p) => n + p.bytes.length, 0) < total) chunks.push(await c.next());
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((p) => p.id === 5 && p.type === VALUE));
  assert.deepEqual(chunks.map((p) => p.bytes.length), [100, 100, total - 200]);
  assert.equal(chunks[0].bytes[99], 0xc3); // first half of "ñ" ends the first packet
  assert.equal(Buffer.concat(chunks.map((p) => p.bytes)).toString('utf8'), body);
  // Sentinel still answered after a multi-packet response.
  c.send(6, VALUE, '');
  const end = await c.next();
  assert.deepEqual([end.id, end.body], [6, '']);
});

test('a handler that never resolves leaves the client waiting, not crashing the fake', async (t) => {
  const { open } = await setup(t, { handlers: { hang: () => new Promise(() => {}) } });
  const stuck = await open();
  stuck.send(2, EXEC, 'hang');
  const other = await open();
  other.send(3, EXEC, 'list');
  assert.equal((await other.next()).id, 3);
  const outcome = await Promise.race([
    stuck.next(),
    new Promise((r) => setTimeout(() => r('still waiting'), 100)),
  ]);
  assert.equal(outcome, 'still waiting');
});

test('dropConnections destroys open RCON sockets but keeps listening', async (t) => {
  const { fake, open } = await setup(t);
  const c = await open();
  fake.dropConnections();
  await new Promise((r) => c.socket.once('close', r));
  const again = await open();
  again.send(9, EXEC, 'list');
  assert.equal((await again.next()).id, 9);
});

test('setOnline(false) refuses connections and drops open ones; setOnline(true) restores', async (t) => {
  const { fake, open } = await setup(t);
  const c = await open();
  const closed = new Promise((r) => c.socket.once('close', r));
  await fake.setOnline(false);
  await closed;
  await assert.rejects(connect(fake.rconPort), { code: 'ECONNREFUSED' });
  await assert.rejects(connect(fake.gamePort), { code: 'ECONNREFUSED' });
  await fake.setOnline(true);
  const again = await open();
  again.send(9, EXEC, 'list');
  assert.equal((await again.next()).id, 9);
});

test('close() releases both ports', async (t) => {
  const fake = await startFakeMinecraft();
  const c = rconClient(await connect(fake.rconPort));
  const closed = new Promise((r) => c.socket.once('close', r));
  await fake.close();
  await closed;
  await assert.rejects(connect(fake.rconPort), { code: 'ECONNREFUSED' });
  await assert.rejects(connect(fake.gamePort), { code: 'ECONNREFUSED' });
  await fake.close(); // idempotent
});

// --- Server List Ping ---

function varInt(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}
const frame = (id, payload = Buffer.alloc(0)) => {
  const inner = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(inner.length), inner]);
};
const mcString = (s) => Buffer.concat([varInt(Buffer.byteLength(s)), Buffer.from(s)]);
const handshake = () => {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return frame(0, Buffer.concat([varInt(769), mcString('localhost'), port, varInt(1)]));
};

function readAll(socket) {
  return new Promise((resolve) => {
    const parts = [];
    socket.on('data', (d) => parts.push(d));
    socket.on('close', () => resolve(Buffer.concat(parts)));
    socket.on('error', () => {});
  });
}

function parseSlp(buf) {
  const readVar = (at) => {
    let value = 0;
    let i = 0;
    for (;; i++) {
      value |= (buf[at + i] & 0x7f) << (7 * i);
      if (!(buf[at + i] & 0x80)) break;
    }
    return { value, next: at + i + 1 };
  };
  const len1 = readVar(0);
  const id1 = readVar(len1.next);
  const strLen = readVar(id1.next);
  const json = buf.toString('utf8', strLen.next, strLen.next + strLen.value);
  const rest = buf.subarray(strLen.next + strLen.value);
  return { id1: id1.value, json: JSON.parse(json), rest };
}

test('SLP: handshake + status request + ping, sent as separate writes', async (t) => {
  const { fake } = await setup(t);
  const socket = await connect(fake.gamePort);
  const all = readAll(socket);
  socket.write(handshake());
  await new Promise((r) => setImmediate(r));
  socket.write(frame(0));
  await new Promise((r) => setTimeout(r, 20));
  const payload = Buffer.alloc(8);
  payload.writeBigInt64BE(1234567890123n);
  socket.write(frame(1, payload));
  const buf = await all;
  const { id1, json, rest } = parseSlp(buf);
  assert.equal(id1, 0);
  assert.deepEqual(json, {
    version: { name: 'Paper 1.21.4', protocol: 769 },
    players: {
      online: 2,
      max: 20,
      sample: [
        { name: 'Steve', id: '8667ba71-b85a-4004-af54-457a9734eed7' },
        { name: 'Alex', id: '6ab43178-89fd-4905-97f6-0f67d9d76fd9' },
      ],
    },
    description: { text: 'A ', extra: [{ text: 'Craft', color: 'green' }] },
  });
  // Pong: length 9, packet id 1, same int64.
  assert.deepEqual([...rest], [...frame(1, payload)]);
});

test('SLP: all three packets coalesced in a single write', async (t) => {
  const { fake } = await setup(t);
  const socket = await connect(fake.gamePort);
  const all = readAll(socket);
  const payload = Buffer.alloc(8);
  payload.writeBigInt64BE(-5n);
  socket.write(Buffer.concat([handshake(), frame(0), frame(1, payload)]));
  const { json, rest } = parseSlp(await all);
  assert.equal(json.players.online, 2);
  assert.deepEqual([...rest], [...frame(1, payload)]);
});
