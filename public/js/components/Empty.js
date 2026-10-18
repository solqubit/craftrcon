// Empty state: an icon, a title, an optional message and an optional action.
import { html } from '../../vendor/htm-preact.js';
import { Icon } from './Icon.js';

export function Empty({ icon = 'inbox', title, message, action }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${22} /></div>
    <h2 class="empty-title">${title}</h2>
    ${message && html`<p class="empty-message">${message}</p>`}
    ${action && html`<div class="empty-action">${action}</div>`}
  </div>`;
}
