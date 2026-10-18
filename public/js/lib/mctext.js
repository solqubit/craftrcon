// Minecraft legacy color text ("§a", "&l", "§x§r§r§g§g§b§b").
// Shared by the backend and the browser: pure ES module, no imports.

export const COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA',
  4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF',
  c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};
const FORMATS = { k: 'obfuscated', l: 'bold', m: 'strike', n: 'underline', o: 'italic' };
const HEX_DIGIT = /^[0-9a-fA-F]$/;

function plainStyle() {
  return { color: null, bold: false, italic: false, underline: false, strike: false, obfuscated: false };
}

// Single tokenizer behind stripCodes and parseLegacy. Yields { text } and
// { code } tokens, where code is a lowercase code char or { hex }.
//  - '§' always starts a code; an unknown char after it is dropped with the '§'
//    (as is a trailing lone '§').
//  - '&' starts a code only when `ampersand` is true and the next char is a
//    known code; otherwise it stays literal text.
function* tokenize(s, ampersand) {
  let text = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const isMarker = ch === '§' || (ampersand && ch === '&');
    if (!isMarker) {
      text += ch;
      i++;
      continue;
    }
    const next = s[i + 1];
    const lower = next === undefined ? '' : next.toLowerCase();
    const known = /^[0-9a-fk-orx]$/.test(lower);
    if (!known) {
      if (ch === '&') { // not a code: literal ampersand
        text += ch;
        i++;
      } else {
        i += 2; // drop '§' and whatever follows it
      }
      continue;
    }
    if (text) { yield { text }; text = ''; }
    if (lower === 'x') {
      let hex = '';
      for (let k = 0; k < 6; k++) {
        const m = s[i + 2 + 2 * k];
        const d = s[i + 3 + 2 * k];
        if (m !== ch || d === undefined || !HEX_DIGIT.test(d)) { hex = null; break; }
        hex += d;
      }
      if (hex) {
        yield { code: { hex: '#' + hex.toUpperCase() } };
        i += 14;
      } else {
        i += 2; // incomplete hex sequence: drop the "§x" only
      }
      continue;
    }
    yield { code: lower };
    i += 2;
  }
  if (text) yield { text };
}

// Removes every color/format code. '&' codes are stripped too unless
// `ampersand` is false (server responses only ever use '§').
export function stripCodes(s, { ampersand = true } = {}) {
  let out = '';
  for (const tok of tokenize(String(s ?? ''), ampersand)) if (tok.text) out += tok.text;
  return out;
}

// A color code (or hex color) resets the formats (Java behavior); '§r' resets everything.
export function parseLegacy(s, { ampersand = false } = {}) {
  const segments = [];
  let style = plainStyle();
  for (const tok of tokenize(String(s ?? ''), ampersand)) {
    if (tok.text !== undefined) {
      const last = segments[segments.length - 1];
      if (last && Object.keys(style).every((k) => last[k] === style[k])) last.text += tok.text;
      else segments.push({ text: tok.text, ...style });
      continue;
    }
    const code = tok.code;
    if (typeof code === 'object') style = { ...plainStyle(), color: code.hex };
    else if (code === 'r') style = plainStyle();
    else if (code in COLORS) style = { ...plainStyle(), color: COLORS[code] };
    else style = { ...style, [FORMATS[code]]: true };
  }
  return segments;
}
