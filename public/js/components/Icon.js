// Small stroke icons (24×24 grid, drawn with currentColor). Decorative: the
// text next to them, or the button's aria-label, carries the meaning.
import { html } from '../../vendor/htm-preact.js';

// Functions, not shared vnodes: Preact must get a fresh vnode per render.
const PATHS = {
  dashboard: () => html`<rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />`,
  console: () => html`<path d="m4 17 6-6-6-6" /><path d="M12 19h8" />`,
  players: () => html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />`,
  moderation: () => html`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" />`,
  world: () => html`<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />`,
  tasks: () => html`<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />`,
  servers: () => html`<rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01" /><path d="M6 18h.01" />`,
  settings: () => html`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" />`,
  logout: () => html`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" />`,
  menu: () => html`<path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" />`,
  close: () => html`<path d="M18 6 6 18" /><path d="m6 6 12 12" />`,
  plus: () => html`<path d="M5 12h14" /><path d="M12 5v14" />`,
  chevronDown: () => html`<path d="m6 9 6 6 6-6" />`,
  eye: () => html`<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />`,
  eyeOff: () => html`<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><path d="m2 2 20 20" />`,
  lock: () => html`<rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />`,
  error: () => html`<circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />`,
  warn: () => html`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" />`,
  success: () => html`<circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />`,
  info: () => html`<circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />`,
  // Server icons (the `icon` field of a server).
  mountain: () => html`<path d="m8 3 4 8 5-5 5 15H2L8 3z" />`,
  sparkle: () => html`<path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9L12 3z" /><path d="M19 17v4" /><path d="M17 19h4" />`,
  sword: () => html`<path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="M13 19l6-6" /><path d="m16 16 4 4" /><path d="m19 21 2-2" />`,
  castle: () => html`<path d="M22 20v-9H2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z" /><path d="M18 11V4H6v7" /><path d="M15 22v-4a3 3 0 0 0-6 0v4" /><path d="M22 11V9" /><path d="M2 11V9" /><path d="M6 4V2" /><path d="M18 4V2" /><path d="M10 4V2" /><path d="M14 4V2" />`,
  tree: () => html`<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z" /><path d="M12 22v-3" />`,
  fire: () => html`<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />`,
  diamond: () => html`<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />`,
  skull: () => html`<path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="12" r="1" /><path d="M12.5 17h-1l.5-1z" />`,
  // Actions.
  edit: () => html`<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />`,
  trash: () => html`<path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />`,
  bolt: () => html`<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />`,
  arrowRight: () => html`<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />`,
  check: () => html`<path d="M20 6 9 17l-5-5" />`,
  inbox: () => html`<path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />`,
  search: () => html`<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />`,
  download: () => html`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" />`,
  eraser: () => html`<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" />`,
  star: () => html`<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />`,
  history: () => html`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />`,
  enter: () => html`<path d="M20 4v7a4 4 0 0 1-4 4H4" /><path d="m9 10-5 5 5 5" />`,
  more: () => html`<circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />`,
  arrowDown: () => html`<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />`,
  arrowUp: () => html`<path d="M12 19V5" /><path d="m5 12 7-7 7 7" />`,
  play: () => html`<polygon points="6 3 20 12 6 21 6 3" />`,
  // Player actions.
  message: () => html`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />`,
  teleport: () => html`<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" />`,
  gamepad: () => html`<path d="M6 12h4" /><path d="M8 10v4" /><path d="M15 13h.01" /><path d="M18 11h.01" /><rect x="2" y="6" width="20" height="12" rx="2" />`,
  gift: () => html`<rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />`,
  ban: () => html`<circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" />`,
  crown: () => html`<path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z" /><path d="M5 20h14" />`,
  shieldOff: () => html`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12h6" />`,
  userPlus: () => html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6" /><path d="M22 11h-6" />`,
  userMinus: () => html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 11h-6" />`,
};

export function Icon({ name, size = 18, class: className = '' }) {
  const draw = PATHS[name] ?? PATHS.info;
  return html`<svg
    class=${`icon ${className}`.trim()}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >${draw()}</svg>`;
}
