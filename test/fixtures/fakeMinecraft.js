// Fake Minecraft server for tests and UI development: a faithful-enough RCON
// server (Source RCON framing) plus a Server List Ping (SLP) status endpoint.
import net from 'node:net';

const TYPE_RESPONSE_VALUE = 0;
const TYPE_AUTH_RESPONSE = 2; // same value as SERVERDATA_EXECCOMMAND
const TYPE_EXEC = 2;
const TYPE_AUTH = 3;
const MAX_PACKET_LENGTH = 4096;
const SPLIT_BYTES = 100;
// Vanilla (net.minecraft.server.rcon.thread.RconClient) reads into a 1460-byte
// buffer, treats each read as exactly one packet and sends responses in
// 4096-byte body fragments.
const VANILLA_READ_BYTES = 1460;
const VANILLA_FRAGMENT_BYTES = 4096;
const HOST = '127.0.0.1';

const UNKNOWN_COMMAND = 'Unknown or incomplete command, see below for error';

// Defaults imitate Paper 1.21. A user handler with the same name replaces one.
const DEFAULT_HANDLERS = {
  list: () => 'There are 2 of a max of 20 players online: Steve, Alex',
  tps: () => '§6TPS from last 1m, 5m, 15m: §a20.0, §a*20.0, §a19.97',
  banlist: () => 'There are no bans',
  whitelist: (args) =>
    args === 'list' ? 'There are 2 whitelisted players: Steve, Alex' : UNKNOWN_COMMAND,
  gamerule: (args) => {
    const [rule, value] = args.split(/\s+/);
    if (!rule) return UNKNOWN_COMMAND;
    return value === undefined
      ? `Gamerule ${rule} is currently set to: false`
      : `Gamerule ${rule} is now set to: ${value}`;
  },
  say: () => '',
};

const SLP_STATUS = {
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
};

// length | id | type | body | 0x00 0x00 (the trailing nulls are already zero).
function encodePacket(id, type, bytes = Buffer.alloc(0)) {
  const out = Buffer.alloc(14 + bytes.length);
  out.writeInt32LE(10 + bytes.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  bytes.copy(out, 12);
  return out;
}

function encodeVarInt(value) {
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

// Returns { value, size } or null when the buffer ends mid-VarInt.
function readVarInt(buf, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error('VarInt too long');
}

function slpFrame(packetId, payload) {
  const inner = Buffer.concat([encodeVarInt(packetId), payload]);
  return Buffer.concat([encodeVarInt(inner.length), inner]);
}

// Options:
//   split: cut response bodies every 100 bytes (even mid UTF-8 character).
//   strict: behave like vanilla's RCON reader. Every 'data' chunk must be exactly
//     one complete packet whose length field equals chunk.length - 4 (at most
//     1460 bytes); anything else closes the connection, as vanilla does. The
//     end-of-response sentinel (type 0) is answered like vanilla: "Unknown
//     request 0", type 0, same id. Long bodies go out in 4096-byte fragments.
//   ignoreSentinel (strict only): never answer type-0 packets, like a server
//     that drops unknown request types.
// `violations` counts connections closed by the strict framing check.
export async function startFakeMinecraft({
  password = 'test',
  rconPort = 0,
  gamePort = 0,
  handlers = {},
  split = false,
  strict = false,
  ignoreSentinel = false,
} = {}) {
  const received = [];
  const sockets = new Set();
  const table = { ...DEFAULT_HANDLERS, ...handlers };
  const stats = { violations: 0 };
  let online = false;
  let closed = false;
  const fragmentBytes = split ? SPLIT_BYTES : strict ? VANILLA_FRAGMENT_BYTES : Infinity;

  async function runCommand(body) {
    const text = body.trim();
    const sp = text.search(/\s/);
    const name = sp < 0 ? text : text.slice(0, sp);
    const args = sp < 0 ? '' : text.slice(sp).trim();
    const handler = Object.hasOwn(table, name) ? table[name] : null;
    if (!handler) return UNKNOWN_COMMAND;
    return String((await handler(args)) ?? '');
  }

  function sendResponse(socket, id, body) {
    if (socket.destroyed) return;
    const bytes = Buffer.from(body, 'utf8');
    if (bytes.length <= fragmentBytes) {
      socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, bytes));
      return;
    }
    // Cut raw bytes, so a multi-byte UTF-8 character may straddle two packets.
    for (let at = 0; at < bytes.length; at += fragmentBytes) {
      socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, bytes.subarray(at, at + fragmentBytes)));
    }
  }

  async function handleRconPacket(socket, state, id, type, body) {
    if (type === TYPE_AUTH) {
      state.authed = body === password;
      socket.write(encodePacket(state.authed ? id : -1, TYPE_AUTH_RESPONSE));
      return;
    }
    if (!state.authed) {
      // Vanilla answers any non-auth packet from an unauthenticated peer with a failure.
      socket.write(encodePacket(-1, TYPE_AUTH_RESPONSE));
      return;
    }
    if (type === TYPE_EXEC) {
      received.push(body);
      sendResponse(socket, id, await runCommand(body));
    } else if (type === TYPE_RESPONSE_VALUE) {
      // End-of-response sentinel. Vanilla replies "Unknown request 0" with the
      // same id (strict mode); the lenient mode echoes an EMPTY body.
      if (strict && ignoreSentinel) return;
      sendResponse(socket, id, strict ? 'Unknown request 0' : '');
    } else {
      sendResponse(socket, id, `Unknown request ${type.toString(16)}`);
    }
  }

  function onRconConnection(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const state = { authed: false };
    let buf = Buffer.alloc(0);
    // Packets run one at a time per connection, so replies keep request order
    // even when a handler is async.
    let chain = Promise.resolve();
    const run = (id, type, body) => {
      chain = chain
        .then(() => handleRconPacket(socket, state, id, type, body))
        .catch(() => socket.destroy());
    };
    socket.on('data', (chunk) => {
      if (strict) {
        // One read = one packet, like vanilla: no buffering across chunks.
        if (
          chunk.length < 14 ||
          chunk.length > VANILLA_READ_BYTES ||
          chunk.readInt32LE(0) !== chunk.length - 4
        ) {
          stats.violations += 1;
          socket.destroy();
          return;
        }
        run(chunk.readInt32LE(4), chunk.readInt32LE(8), chunk.toString('utf8', 12, chunk.length - 2));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const length = buf.readInt32LE(0);
        if (length < 10 || length > MAX_PACKET_LENGTH) {
          socket.destroy();
          return;
        }
        if (buf.length < 4 + length) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, 4 + length - 2);
        buf = buf.subarray(4 + length);
        run(id, type, body);
      }
    });
  }

  function onGameConnection(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let state = 'handshake';
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const len = readVarInt(buf, 0);
          if (!len || buf.length < len.size + len.value) return;
          const frame = buf.subarray(len.size, len.size + len.value);
          buf = buf.subarray(len.size + len.value);
          const pid = readVarInt(frame, 0);
          const payload = frame.subarray(pid.size);
          if (state === 'handshake' && pid.value === 0) {
            const protocol = readVarInt(payload, 0);
            const host = readVarInt(payload, protocol.size);
            const next = readVarInt(payload, protocol.size + host.size + host.value + 2);
            if (next.value !== 1) return socket.destroy();
            state = 'status';
          } else if (state === 'status' && pid.value === 0) {
            const json = Buffer.from(JSON.stringify(SLP_STATUS), 'utf8');
            socket.write(slpFrame(0, Buffer.concat([encodeVarInt(json.length), json])));
          } else if (state === 'status' && pid.value === 1 && payload.length === 8) {
            socket.end(slpFrame(1, payload));
            return;
          } else {
            return socket.destroy();
          }
        }
      } catch {
        socket.destroy();
      }
    });
  }

  const rconServer = net.createServer(onRconConnection);
  const gameServer = net.createServer(onGameConnection);

  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  const stopListening = (server) =>
    new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
  const dropConnections = () => {
    for (const socket of sockets) socket.destroy();
  };

  // Serialize online/offline/close so concurrent calls cannot interleave.
  let queue = Promise.resolve();
  const serial = (fn) => {
    queue = queue.then(fn, fn);
    return queue;
  };

  const ports = {};
  ports.rcon = await listen(rconServer, rconPort);
  try {
    ports.game = await listen(gameServer, gamePort);
  } catch (err) {
    await stopListening(rconServer);
    throw err;
  }
  online = true;

  return {
    rconPort: ports.rcon,
    gamePort: ports.game,
    received,
    stats,
    dropConnections,
    // Offline: stop listening (new connections are refused) and drop open ones,
    // like a server shutting down. Online: listen again on the same ports.
    // Returns a promise; await it before connecting.
    setOnline(value) {
      return serial(async () => {
        if (closed || value === online) return;
        online = value;
        if (value) {
          await listen(rconServer, ports.rcon);
          await listen(gameServer, ports.game);
        } else {
          dropConnections();
          await Promise.all([stopListening(rconServer), stopListening(gameServer)]);
        }
      });
    },
    close() {
      return serial(async () => {
        closed = true;
        online = false;
        dropConnections();
        await Promise.all([stopListening(rconServer), stopListening(gameServer)]);
      });
    },
  };
}
