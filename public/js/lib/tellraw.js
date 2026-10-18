// Builds the commands that announce a message to the players: `tellraw` (a text
// component with colors and formats) and `say`. Pure ES module, no DOM.
//
// The message is written with '&' codes ("&aHello &lworld"); parseLegacy turns
// it into styled segments and those become a text component. Java 1.21.5 moved
// `tellraw` from JSON to SNBT, so the same component is written either way:
//   JSON  {"text":"","extra":[{"text":"Hi","color":"green"}]}
//   SNBT  {text:'',extra:[{text:'Hi',color:'green'}]}
import { COLORS, parseLegacy } from './mctext.js';
import { oneLine } from './names.js';

// Minecraft's names of the 16 legacy colors, by their code.
const COLOR_NAMES = {
  0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua',
  4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray',
  8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua',
  c: 'red', d: 'light_purple', e: 'yellow', f: 'white',
};

export const LEGACY_COLORS = Object.entries(COLOR_NAMES).map(([code, name]) => ({ code, name, hex: COLORS[code] }));

const NAME_BY_HEX = new Map(LEGACY_COLORS.map(({ name, hex }) => [hex, name]));

// parseLegacy flag -> text component key, in the order they are written.
const FORMAT_KEYS = [
  ['bold', 'bold'],
  ['italic', 'italic'],
  ['underline', 'underlined'],
  ['strike', 'strikethrough'],
  ['obfuscated', 'obfuscated'],
];

// Segments of parseLegacy -> { text: '', extra: [...] }. A color that is one of
// the 16 legacy ones becomes its name, any other is kept as "#RRGGBB".
export function segmentsToComponent(segments) {
  const extra = segments.map((seg) => {
    const part = { text: seg.text };
    if (seg.color) part.color = NAME_BY_HEX.get(seg.color.toUpperCase()) ?? seg.color;
    for (const [flag, key] of FORMAT_KEYS) if (seg[flag]) part[key] = true;
    return part;
  });
  return { text: '', extra };
}

// First "1.21.4" / "26.1" in the string; null when there is none or it is a
// weekly snapshot ("25w10a").
function parseVersion(version) {
  const text = String(version ?? '');
  if (/\b\d{2}w\d{2}[a-z]\b/i.test(text)) return null;
  const match = text.match(/\d+\.\d+(?:\.\d+)?/);
  if (!match) return null;
  const [major, minor, patch = 0] = match[0].split('.').map(Number);
  return { major, minor, patch };
}

// True when the server's `tellraw` reads SNBT: Java 1.21.5 and later, and the
// year-based versions (26.1, ...). Anything unrecognised is treated as JSON.
export function usesSnbt(version) {
  const v = parseVersion(version);
  if (!v) return false;
  if (v.major >= 26) return true;
  if (v.major !== 1) return false;
  return v.minor > 21 || (v.minor === 21 && v.patch >= 5);
}

const snbtString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function toSnbt(value) {
  if (typeof value === 'string') return snbtString(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toSnbt).join(',')}]`;
  return `{${Object.entries(value).map(([k, v]) => `${k}:${toSnbt(v)}`).join(',')}}`;
}

function fail(code) {
  throw new Error(code);
}

// `tellraw <target> <component>`. Throws 'empty_message' when nothing would be
// shown. Line breaks are folded first, so the command stays one line.
export function buildTellraw(message, { version, target = '@a' } = {}) {
  const segments = parseLegacy(oneLine(message), { ampersand: true });
  if (segments.length === 0 || segments.every((seg) => seg.text.trim() === '')) fail('empty_message');
  const component = segmentsToComponent(segments);
  return `tellraw ${target} ${usesSnbt(version) ? toSnbt(component) : JSON.stringify(component)}`;
}

// `say <message>` on one line (the server shows it as "[Server] ..."; no colors).
export function buildSay(message) {
  const text = oneLine(message).trim();
  if (text === '') fail('empty_message');
  return `say ${text}`;
}
