// Yes/no confirmation built on Modal. With `danger`, the confirm button is red
// and the safe choice (Cancel) gets the initial focus.
import { html } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { Modal } from './Modal.js';

export function Confirm({ open = true, title, message, confirmLabel, danger = false, busy = false, onConfirm, onCancel }) {
  const close = () => {
    if (!busy) onCancel?.();
  };
  const footer = html`
    <button type="button" class="btn btn-secondary" onClick=${close} disabled=${busy} autofocus=${danger}>
      ${t('common.cancel')}
    </button>
    <button
      type="button"
      class=${`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
      onClick=${onConfirm}
      disabled=${busy}
      aria-busy=${busy ? 'true' : undefined}
      autofocus=${!danger}
    >
      ${busy && html`<span class="spinner" aria-hidden="true"></span>`}
      ${confirmLabel ?? t('common.confirm')}
    </button>
  `;
  return html`<${Modal} open=${open} title=${title} onClose=${close} footer=${footer} size="sm">
    ${typeof message === 'string' ? html`<p class="confirm-message">${message}</p>` : message}
  </${Modal}>`;
}
