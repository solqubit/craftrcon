// Shared by the backend and the browser: pure ES module, no imports.

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function isValidPlayerName(n) {
  return typeof n === 'string' && PLAYER_NAME.test(n);
}

// Collapses every run of CR/LF into one space and drops NULs, so a pasted
// value cannot smuggle a second command into a one-line RCON request.
export function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\0/g, '');
}
