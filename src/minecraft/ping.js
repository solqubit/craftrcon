// Minecraft Server List Ping (status + ping/pong) over node:net, plus the helpers
// that turn the status JSON into something the panel can show.
//
// Frame: VarInt length | VarInt packet id | payload.
// Flow: handshake (protocol -1, next state 1) + status request -> status JSON ->
// ping (int64) -> pong (same int64).
import net from 'node:net';

const MAX_PACKET_LENGTH = 1024 * 1024; // a status response is a few KiB; 1 MiB is generous
const MAX_VARINT_BYTES = 5;
const MAX_COMPONENT_DEPTH = 100;

const SOCKET_ERROR_CODES = {
  ECONNREFUSED: 'ECONNREFUSED',
  ETIMEDOUT: 'ETIMEDOUT',
  EHOSTUNREACH: 'EHOSTUNREACH',
  ENETUNREACH: 'EHOSTUNREACH',
  ENOTFOUND: 'ENOTFOUND',
  EAI_AGAIN: 'ENOTFOUND',
};

const COLOR_CODES = {
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

// Order matters: it is the order the codes are emitted in.
const FORMAT_CODES = {
  obfuscated: 'k',
  bold: 'l',
  strikethrough: 'm',
  underlined: 'n',
  italic: 'o',
};

class PingError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------------------------------------------------------------- components

// Returns the legacy code suffix for a component color, or null when unset/invalid.
function colorToLegacy(color) {
  if (typeof color !== 'string') return null;
  if (Object.hasOwn(COLOR_CODES, color)) return `§${COLOR_CODES[color]}`;
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return '§x' + [...color.slice(1).toLowerCase()].map((digit) => `§${digit}`).join('');
  }
  return null;
}

// A list is a component whose first element is the parent and the rest its `extra`.
function normalizeArray(list) {
  const [first, ...rest] = list;
  if (Array.isArray(first)) return { text: '', extra: [...first, ...rest] };
  if (first !== null && typeof first === 'object') {
    const extra = Array.isArray(first.extra) ? first.extra : [];
    return { ...first, extra: [...extra, ...rest] };
  }
  return { text: first === undefined || first === null ? '' : String(first), extra: rest };
}

// Converts a text component to a string with § codes. Style is tracked as what the
// client would currently show (`shown`), so codes are only emitted on a change:
// a color code also clears formats in-game, and nothing but §r removes a style.
export function componentToLegacy(component) {
  if (typeof component === 'string') return component;
  const shown = { color: null, formats: new Set() };
  let out = '';

  function emitSegment(text, style) {
    if (text === '') return;
    const lost =
      (shown.color !== null && style.color === null) ||
      [...shown.formats].some((f) => !style.formats.has(f));
    if (lost) {
      out += '§r';
      shown.color = null;
      shown.formats.clear();
    }
    if (style.color !== null && style.color !== shown.color) {
      out += style.color;
      shown.color = style.color;
      shown.formats.clear();
    }
    for (const format of style.formats) {
      if (!shown.formats.has(format)) {
        out += `§${FORMAT_CODES[format]}`;
        shown.formats.add(format);
      }
    }
    out += text;
  }

  function walk(node, inherited, depth) {
    if (depth > MAX_COMPONENT_DEPTH || node === null || node === undefined) return;
    if (Array.isArray(node)) return walk(normalizeArray(node), inherited, depth + 1);
    if (typeof node !== 'object') return emitSegment(String(node), inherited);

    const style = { color: inherited.color, formats: new Set(inherited.formats) };
    const color = colorToLegacy(node.color);
    if (color !== null) style.color = color;
    for (const name of Object.keys(FORMAT_CODES)) {
      if (node[name] === true || node[name] === 'true') style.formats.add(name);
      else if (node[name] === false || node[name] === 'false') style.formats.delete(name);
    }

    if (node.text !== undefined && node.text !== null) emitSegment(String(node.text), style);
    if (Array.isArray(node.extra)) {
      for (const child of node.extra) walk(child, style, depth + 1);
    }
  }

  walk(component, { color: null, formats: new Set() }, 0);
  return out;
}

export function detectSoftware(versionName) {
  const name = typeof versionName === 'string' ? versionName.toLowerCase() : '';
  if (name.includes('purpur')) return 'Purpur';
  if (name.includes('paper')) return 'Paper';
  if (name.includes('spigot')) return 'Spigot';
  if (name.includes('fabric')) return 'Fabric';
  if (name.includes('forge')) return 'Forge'; // also NeoForge
  return 'Vanilla';
}

// ------------------------------------------------------------------ protocol

function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0; // negative numbers use the 5-byte two's complement form
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

// Returns { value, size }, or null when the buffer ends mid-VarInt.
function readVarInt(buf, offset) {
  let value = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new PingError('PROTOCOL', 'VarInt too long');
}

function frame(packetId, payload = Buffer.alloc(0)) {
  const inner = Buffer.concat([encodeVarInt(packetId), payload]);
  return Buffer.concat([encodeVarInt(inner.length), inner]);
}

function encodeString(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

// Takes one complete frame off the front of `buf`: { id, payload, rest } or null.
function takeFrame(buf) {
  const length = readVarInt(buf, 0);
  if (!length) return null;
  if (length.value < 1 || length.value > MAX_PACKET_LENGTH) {
    throw new PingError('PROTOCOL', `Invalid packet length ${length.value}`);
  }
  const end = length.size + length.value;
  if (buf.length < end) return null;
  const inner = buf.subarray(length.size, end);
  const id = readVarInt(inner, 0);
  if (!id) throw new PingError('PROTOCOL', 'Truncated packet id');
  return { id: id.value, payload: inner.subarray(id.size), rest: buf.subarray(end) };
}

function parseStatus(payload) {
  const length = readVarInt(payload, 0);
  if (!length || length.value < 0 || length.size + length.value > payload.length) {
    throw new PingError('PROTOCOL', 'Invalid status string');
  }
  const text = payload.toString('utf8', length.size, length.size + length.value);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PingError('PROTOCOL', 'Status is not valid JSON');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new PingError('PROTOCOL', 'Status is not a JSON object');
  }
  return json;
}

function buildResult(json, latencyMs) {
  const version = typeof json.version?.name === 'string' ? json.version.name : '';
  const sample = Array.isArray(json.players?.sample)
    ? json.players.sample.map((p) => p?.name).filter((n) => typeof n === 'string')
    : [];
  return {
    online: true,
    version,
    protocol: Number.isInteger(json.version?.protocol) ? json.version.protocol : null,
    software: detectSoftware(version),
    players: {
      online: Number.isInteger(json.players?.online) ? json.players.online : 0,
      max: Number.isInteger(json.players?.max) ? json.players.max : 0,
      sample,
    },
    motd: componentToLegacy(json.description ?? ''),
    latencyMs,
  };
}

function errorCode(err) {
  if (err instanceof PingError) return err.code;
  // With autoSelectFamily the error may be an AggregateError wrapping the real ones.
  const code = SOCKET_ERROR_CODES[err?.code] ?? SOCKET_ERROR_CODES[err?.errors?.[0]?.code];
  return code ?? 'PROTOCOL';
}

// Never rejects and never leaves the socket open. `timeoutMs` bounds the whole
// exchange (connect, status and pong).
export function serverListPing({ host, port = 25565, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    let phase = 'status'; // 'status' -> 'pong'
    let buf = Buffer.alloc(0);
    let result = null; // set once the status arrived
    let statusLatency = 0;
    let requestedAt = 0;
    let pingSentAt = 0;

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.on('error', () => {});
      socket?.destroy();
      resolve(value);
    }

    // After the status arrived the server is online no matter how the pong goes.
    const fail = (code) => finish(result ?? { online: false, error: code });

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const packet = takeFrame(buf);
          if (!packet) return;
          buf = packet.rest;
          if (phase === 'status') {
            if (packet.id !== 0) throw new PingError('PROTOCOL', 'Unexpected status packet');
            statusLatency = Math.max(0, Date.now() - requestedAt);
            result = buildResult(parseStatus(packet.payload), statusLatency);
            phase = 'pong';
            const payload = Buffer.alloc(8);
            pingSentAt = Date.now();
            payload.writeBigInt64BE(BigInt(pingSentAt));
            socket.write(frame(1, payload));
          } else {
            if (packet.id === 1) {
              result.latencyMs = Math.max(0, Date.now() - pingSentAt);
            }
            return finish(result);
          }
        }
      } catch (err) {
        fail(errorCode(err));
      }
    }

    try {
      timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
      socket = net.connect({ host, port });
      socket.setNoDelay(true);
      socket.on('error', (err) => fail(errorCode(err)));
      socket.on('close', () => fail('PROTOCOL'));
      socket.on('data', onData);
      socket.on('connect', () => {
        const handshake = Buffer.concat([
          encodeVarInt(-1),
          encodeString(String(host)),
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          encodeVarInt(1),
        ]);
        requestedAt = Date.now();
        socket.write(Buffer.concat([frame(0, handshake), frame(0)]));
      });
    } catch (err) {
      fail(errorCode(err));
    }
  });
}
