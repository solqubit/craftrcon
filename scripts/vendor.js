// Copies the browser libraries the SPA imports into public/vendor/, so the
// panel never loads anything from a CDN. Run with `npm run vendor` after
// upgrading htm, and commit the output.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILES = [
  // htm + Preact + hooks in one ES module (htm: Apache-2.0, Preact: MIT).
  ['node_modules/htm/preact/standalone.module.js', 'public/vendor/htm-preact.js'],
];

const root = new URL('../', import.meta.url);
mkdirSync(new URL('public/vendor/', root), { recursive: true });
for (const [from, to] of FILES) {
  copyFileSync(fileURLToPath(new URL(from, root)), fileURLToPath(new URL(to, root)));
  console.log(`${from} -> ${to}`);
}
