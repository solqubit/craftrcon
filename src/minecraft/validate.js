import { isValidPlayerName } from '../../public/js/lib/names.js';

export { isValidPlayerName };

// Vanilla RCON refuses requests above this many payload bytes.
const MAX_COMMAND_BYTES = 1446;
const encoder = new TextEncoder();

// Trims, drops one leading '/', and rejects anything that could split or
// truncate the request (CR, LF, NUL) or exceed the payload limit.
export function validateCommand(cmd) {
  if (typeof cmd !== 'string') return { ok: false, error: 'empty' };
  let command = cmd.trim();
  if (command.startsWith('/')) command = command.slice(1).trim();
  if (command === '') return { ok: false, error: 'empty' };
  if (/[\r\n\0]/.test(command)) return { ok: false, error: 'invalid_chars' };
  if (encoder.encode(command).length > MAX_COMMAND_BYTES) return { ok: false, error: 'too_long' };
  return { ok: true, command };
}
