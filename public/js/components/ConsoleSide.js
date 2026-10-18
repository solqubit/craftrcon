// Console side panel: the Favorites and History cards, each with its
// loading, empty and error (with retry) states.
import { html } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { Icon } from './Icon.js';

function SideCard({ icon, title, action, children }) {
  return html`<section class="card cl-side-card">
    <header class="cl-side-head">
      <h2 class="card-title cl-side-title"><${Icon} name=${icon} size=${15} />${title}</h2>
      ${action}
    </header>
    ${children}
  </section>`;
}

function SideState({ state, failedKey, emptyKey, onRetry }) {
  if (state === null) {
    return html`<div class="cl-side-state" role="status">
      <span class="spinner" aria-hidden="true"></span><span class="sr-only">${t('common.loading')}</span>
    </div>`;
  }
  if (state === 'error') {
    return html`<div class="cl-side-state">
      <p>${t(failedKey)}</p>
      <button type="button" class="btn btn-secondary btn-sm" onClick=${onRetry}>${t('common.retry')}</button>
    </div>`;
  }
  return html`<p class="cl-side-empty">${t(emptyKey)}</p>`;
}

export function Favorites({ favorites, onRun, onAdd, onEdit, onRetry }) {
  const action = html`<button type="button" class="btn btn-ghost btn-sm" onClick=${onAdd} aria-label=${t('console.favorites.addLabel')}>
    <${Icon} name="plus" size=${14} />${t('console.favorites.add')}
  </button>`;
  return html`<${SideCard} icon="star" title=${t('console.favorites.title')} action=${action}>
    ${Array.isArray(favorites) && favorites.length > 0
      ? html`<ul class="cl-favs">
          ${favorites.map(
            (fav) => html`<li key=${fav.id} class="cl-fav">
              <button type="button" class="cl-fav-run" title=${t('console.favorites.run', { command: fav.command })} onClick=${() => onRun(fav.command)}>
                <span class="cl-fav-label">${fav.label}</span>
                <code class="cl-fav-cmd">${fav.command}</code>
              </button>
              <button type="button" class="icon-btn icon-btn-sm cl-fav-edit" aria-label=${t('console.favorites.edit', { label: fav.label })} onClick=${() => onEdit(fav)}>
                <${Icon} name="edit" size=${13} />
              </button>
            </li>`,
          )}
        </ul>`
      : html`<${SideState} state=${favorites} failedKey="console.favorites.loadFailed" emptyKey="console.favorites.empty" onRetry=${onRetry} />`}
  </${SideCard}>`;
}

export function History({ history, onPick, onRetry }) {
  return html`<${SideCard} icon="history" title=${t('console.history.title')}>
    ${Array.isArray(history) && history.length > 0
      ? html`<ul class="cl-hist">
            ${history.map(
              (command) => html`<li key=${command}>
                <button type="button" class="cl-hist-item" title=${t('console.history.use', { command })} onClick=${() => onPick(command)}>${command}</button>
              </li>`,
            )}
          </ul>
          <p class="cl-side-hint">${t('console.history.hint')}</p>`
      : html`<${SideState} state=${history} failedKey="console.history.loadFailed" emptyKey="console.history.empty" onRetry=${onRetry} />`}
  </${SideCard}>`;
}
