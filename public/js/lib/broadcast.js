// Logic of the Broadcast editor: the color/format buttons, inserting a code at
// the cursor, the command a message becomes, the byte budget of an RCON request
// and the remembered mode. Pure ES module (storage is passed in).
import { buildSay, buildTellraw, LEGACY_COLORS } from './tellraw.js';

// Vanilla RCON refuses requests above this many payload bytes (the backend
// checks the same limit in src/minecraft/validate.js).
export const MAX_COMMAND_BYTES = 1446;

export const BROADCAST_MODES = ['tellraw', 'say'];
export const DEFAULT_MODE = 'tellraw';
const MODE_KEY = 'craftrcon.broadcastMode';

export const COLOR_BUTTONS = LEGACY_COLORS;
// Obfuscated (&k) is left out: it is only noise in an announcement.
export const FORMAT_BUTTONS = [
  { code: 'l', name: 'bold' },
  { code: 'o', name: 'italic' },
  { code: 'n', name: 'underline' },
  { code: 'm', name: 'strikethrough' },
  { code: 'r', name: 'reset' },
];

const encoder = new TextEncoder();

// Puts "&<code>" at `start` (the start of the selection; the selection itself
// stays), and returns the new text with the cursor just after the code. With no
// known cursor the code goes at the end.
export function insertCode(value, start, end, code) {
  const at = Number.isInteger(start) ? Math.min(Math.max(start, 0), value.length) : value.length;
  const inserted = `&${code}`;
  return { text: value.slice(0, at) + inserted + value.slice(at), cursor: at + inserted.length };
}

// The command to send, or null when there is nothing to say.
export function broadcastCommand(mode, message, { version } = {}) {
  try {
    return mode === 'say' ? buildSay(message) : buildTellraw(message, { version });
  } catch {
    return null;
  }
}

// Bytes left in the request (negative when over the limit).
export function remainingBytes(command) {
  return MAX_COMMAND_BYTES - (command ? encoder.encode(command).length : 0);
}

export function loadMode(storage) {
  try {
    const mode = storage?.getItem(MODE_KEY);
    return BROADCAST_MODES.includes(mode) ? mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function saveMode(storage, mode) {
  try {
    storage?.setItem(MODE_KEY, mode);
  } catch {
    // storage blocked: the mode just isn't remembered
  }
}
