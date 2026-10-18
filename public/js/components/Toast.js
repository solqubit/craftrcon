// Transient notifications: call toast() from anywhere; <Toasts/> (rendered once
// by the app root) shows them in a polite live region.
import { html, useEffect, useState } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { Icon } from './Icon.js';

const TYPES = new Set(['success', 'error', 'warn', 'info']);
const DEFAULT_TIMEOUT_MS = { success: 4000, info: 4000, warn: 6000, error: 7000 };

let toasts = [];
let nextId = 1;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(toasts));

export function dismissToast(id) {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

// type: 'success' | 'error' | 'warn' | 'info'. A timeout of 0 keeps it until closed.
export function toast(message, { type = 'success', timeout } = {}) {
  const kind = TYPES.has(type) ? type : 'info';
  const id = nextId++;
  toasts = [...toasts, { id, message, type: kind }];
  emit();
  const ms = timeout ?? DEFAULT_TIMEOUT_MS[kind];
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function Toasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    setList(toasts);
    listeners.add(setList);
    return () => listeners.delete(setList);
  }, []);
  return html`<div class="toast-region" role="status" aria-live="polite">
    ${list.map(
      (item) => html`<div key=${item.id} class=${`toast toast-${item.type}`}>
        <${Icon} name=${item.type} class="toast-icon" />
        <p class="toast-message">${item.message}</p>
        <button type="button" class="icon-btn icon-btn-sm" aria-label=${t('common.dismiss')} onClick=${() => dismissToast(item.id)}>
          <${Icon} name="close" size=${14} />
        </button>
      </div>`,
    )}
  </div>`;
}
