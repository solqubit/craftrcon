// Which commands ask for confirmation before they are sent. Pure ES module.

// Lowercase, without one leading '/', with every whitespace run as one space:
// "  / Kill   @E " -> "kill @e". The API strips the slash the same way, so
// none of these spellings can slip past the check.
function normalize(command) {
  let s = String(command).trim();
  if (s.startsWith('/')) s = s.slice(1).trim();
  return s.replace(/\s+/g, ' ').toLowerCase();
}

// True when `command` equals an entry of `list`, or starts with an entry
// followed by a space (whole words: "op" matches "op Steve", not "opx").
export function isDangerous(command, list) {
  if (!Array.isArray(list)) return false;
  const cmd = normalize(command ?? '');
  if (cmd === '') return false;
  return list.some((raw) => {
    if (typeof raw !== 'string') return false;
    const entry = normalize(raw);
    return entry !== '' && (cmd === entry || cmd.startsWith(`${entry} `));
  });
}
