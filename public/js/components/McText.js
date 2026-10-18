// Minecraft legacy color text ("§6Gold", or "&6Gold" with `ampersand`) as styled spans.
import { html } from '../../vendor/htm-preact.js';
import { parseLegacy } from '../lib/mctext.js';

function segmentClass(seg) {
  let cls = '';
  if (seg.bold) cls += ' mc-bold';
  if (seg.italic) cls += ' mc-italic';
  if (seg.underline) cls += ' mc-underline';
  if (seg.strike) cls += ' mc-strike';
  if (seg.obfuscated) cls += ' mc-obfuscated';
  return cls.trim();
}

export function McText({ text, ampersand = false }) {
  const segments = parseLegacy(text ?? '', { ampersand });
  return html`<span class="mctext">${segments.map((seg) => {
    const cls = segmentClass(seg);
    if (!cls && !seg.color) return seg.text;
    return html`<span class=${cls || undefined} style=${seg.color ? { color: seg.color } : undefined}>${seg.text}</span>`;
  })}</span>`;
}
