// Which commands ask for confirmation before they are sent. Pure ES module.

// Lowercase, without any leading slashes or a "minecraft:" namespace on the
// command name, with every whitespace run as one space:
// "  // Minecraft:Kill   @E " -> "kill @e". The API strips one '/' and vanilla's
// dispatcher accepts another one and the namespace, so "//stop" or
// "minecraft:stop" would still stop the server: none of them may slip past.
function normalize(command) {
  return String(command)
    .replace(/^[\s/]+/, '')
    .replace(/^minecraft:/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
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
