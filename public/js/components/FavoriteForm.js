import { html, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { commandProblem, errorKey, normalizeCommand } from '../lib/console.js';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';

const MAX_LABEL = 40; // the API's limit for a favorite's label

// Add / edit a favorite. Editing also offers Delete (confirmed by the owner).
export function FavoriteForm({ serverId, favorite, initialCommand, onClose, onSaved, onDelete }) {
  const editing = favorite !== null;
  const [label, setLabel] = useState(favorite?.label ?? '');
  const [command, setCommand] = useState(favorite?.command ?? initialCommand);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  function validate() {
    const found = {};
    const l = label.trim();
    if (l === '') found.label = 'required';
    else if (l.length > MAX_LABEL) found.label = 'too_long';
    const problem = commandProblem(command);
    if (problem) found.command = problem;
    return found;
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      document.getElementById(found.label ? 'fav-label' : 'fav-command')?.focus();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      const body = { label: label.trim(), command: normalizeCommand(command) };
      const saved = await api(editing ? `/api/servers/${serverId}/favorites/${favorite.id}` : `/api/servers/${serverId}/favorites`, {
        method: editing ? 'PUT' : 'POST',
        body,
      });
      onSaved(saved, editing);
    } catch (err) {
      setSaving(false);
      if (err.status === 400 && err.body?.fields) setErrors(err.body.fields);
      else if (err.status !== 401) setFailed(true);
    }
  }

  const labelError = errors.label && t(`console.favorites.errors.${['required', 'too_long'].includes(errors.label) ? errors.label : 'invalid'}`);
  const commandError = errors.command && t(errorKey(errors.command));

  const footer = html`
    ${editing &&
    html`<button type="button" class="btn btn-danger cl-fav-delete" onClick=${() => onDelete(favorite)} disabled=${saving}>
      <${Icon} name="trash" size=${15} />${t('common.delete')}
    </button>`}
    <button type="button" class="btn btn-secondary" onClick=${onClose} disabled=${saving}>${t('common.cancel')}</button>
    <button type="submit" form="favorite-form" class="btn btn-primary" disabled=${saving} aria-busy=${saving ? 'true' : undefined}>
      ${saving && html`<span class="spinner" aria-hidden="true"></span>`}${t('common.save')}
    </button>
  `;

  return html`<${Modal} title=${t(editing ? 'console.favorites.editTitle' : 'console.favorites.addTitle')} size="sm" onClose=${onClose} busy=${saving} footer=${footer}>
    <form id="favorite-form" class="server-form" onSubmit=${submit} noValidate>
      <div class="field">
        <label class="label" for="fav-label">${t('console.favorites.label')}</label>
        <input
          id="fav-label"
          class="input"
          type="text"
          value=${label}
          maxlength=${MAX_LABEL}
          placeholder=${t('console.favorites.labelPlaceholder')}
          onInput=${(e) => { setLabel(e.currentTarget.value); setErrors(({ label: _gone, ...rest }) => rest); }}
          disabled=${saving}
          aria-invalid=${labelError ? 'true' : undefined}
          aria-describedby=${labelError ? 'fav-label-error' : undefined}
          autocomplete="off"
          autofocus
        />
        ${labelError && html`<p id="fav-label-error" class="field-error" role="alert">${labelError}</p>`}
      </div>
      <div class="field">
        <label class="label" for="fav-command">${t('console.favorites.command')}</label>
        <input
          id="fav-command"
          class="input mono"
          type="text"
          value=${command}
          placeholder=${t('console.favorites.commandPlaceholder')}
          onInput=${(e) => { setCommand(e.currentTarget.value); setErrors(({ command: _gone, ...rest }) => rest); }}
          disabled=${saving}
          aria-invalid=${commandError ? 'true' : undefined}
          aria-describedby=${commandError ? 'fav-command-error' : 'fav-command-hint'}
          autocomplete="off"
          autocapitalize="off"
          spellcheck=${false}
        />
        ${commandError
          ? html`<p id="fav-command-error" class="field-error" role="alert">${commandError}</p>`
          : html`<p id="fav-command-hint" class="hint">${t('console.favorites.commandHint')}</p>`}
      </div>
      <div class="alert alert-error" role="alert" hidden=${!failed}>
        <${Icon} name="error" size=${16} />
        <span>${t('console.favorites.errors.saveFailed')}</span>
      </div>
    </form>
  </${Modal}>`;
}
