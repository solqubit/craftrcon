// A player's skin head from the panel's cached proxy. Names the proxy rejects
// (Bedrock "."-prefixed names, invalid input) answer 400: swap to the generic
// head once; if the fallback itself fails, stop there instead of looping.
import { html } from '../../vendor/htm-preact.js';

const FALLBACK = '/img/head-fallback.svg';

function swapToFallback(event) {
  const img = event.currentTarget;
  if (new URL(img.src, location.href).pathname === FALLBACK) return;
  img.src = FALLBACK;
}

export function Head({ name, size = 24 }) {
  return html`<img
    class="head"
    src=${`/api/heads/${encodeURIComponent(name ?? '')}`}
    width=${size}
    height=${size}
    alt=""
    loading="lazy"
    decoding="async"
    onError=${swapToFallback}
  />`;
}
