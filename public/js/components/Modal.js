// Modal dialog on the native <dialog>: the browser traps focus, closes on
// Escape (reported through onClose) and restores focus when it closes.
// Render it only while open: <${Modal} open=${x} ...> or {x && html`...`}.
// While `busy` (or without onClose) it cannot be dismissed.
import { html, useEffect, useRef } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { Icon } from './Icon.js';

let nextId = 1;

export function Modal({ open = true, title, onClose, footer, size = 'md', busy = false, children }) {
  const ref = useRef(null);
  const titleId = useRef(`modal-title-${nextId++}`).current;
  const latest = useRef({});
  latest.current = { onClose, busy };
  const dismissable = () => Boolean(latest.current.onClose) && !latest.current.busy;

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement;
    // The browser can close the dialog on its own (a repeated Escape skips the
    // cancelable 'cancel' event), so 'close' is the source of truth: report it
    // to the owner, or reopen when the dialog may not be dismissed now.
    const onNativeClose = () => {
      if (dismissable()) latest.current.onClose();
      else dialog.showModal();
    };
    dialog.addEventListener('close', onNativeClose);
    dialog.showModal();
    return () => {
      dialog.removeEventListener('close', onNativeClose);
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const onCancel = (event) => {
    event.preventDefault(); // Escape: let the owner decide
    if (dismissable()) onClose();
  };
  // A click on the <dialog> itself (not its card) is a click on the backdrop.
  const onBackdrop = (event) => {
    if (event.target === ref.current && dismissable()) onClose();
  };

  return html`<dialog ref=${ref} class=${`modal modal-${size}`} aria-labelledby=${titleId} aria-busy=${busy ? 'true' : undefined} onCancel=${onCancel} onClick=${onBackdrop}>
    <div class="modal-card">
      <header class="modal-head">
        <h2 id=${titleId} class="modal-title">${title}</h2>
        ${onClose &&
        html`<button type="button" class="icon-btn" aria-label=${t('common.close')} onClick=${onClose} disabled=${busy}>
          <${Icon} name="close" />
        </button>`}
      </header>
      <div class="modal-body">${children}</div>
      ${footer && html`<footer class="modal-foot">${footer}</footer>`}
    </div>
  </dialog>`;
}
