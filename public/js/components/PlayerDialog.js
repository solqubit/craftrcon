// The small dialog of a Players action that needs details (a reason, a mode, a
// destination, an item and amount, or a message). It builds the command with
// lib/players.js and hands it to `onSubmit`; the page runs it. Mount it only
// while it is open.
import { html, useMemo, useState } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { GAME_MODES, MAX_GIVE_COUNT } from '../lib/builders.js';
import { buildAction, errorField, suggestItems } from '../lib/players.js';
import { Modal } from './Modal.js';

const FORM_ID = 'player-action-form';
const MAX_TEXT = 256; // reasons and messages: well inside RCON's limit

// Item field with autocompletion over the generated item list. The matches
// show right under the input (not as a floating layer, so the dialog never
// clips them).
function ItemPicker({ id, value, onChange, invalid, describedBy, disabled }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => (open ? suggestItems(value) : []), [open, value]);
  const showList = matches.length > 0 && !(matches.length === 1 && matches[0] === value.trim());
  const activeIndex = Math.min(active, matches.length - 1);
  const listId = `${id}-list`;

  function choose(item) {
    onChange(item);
    setOpen(false);
  }

  function onKeyDown(event) {
    if (!showList) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const n = matches.length;
      setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (event.key === 'Enter' && matches[activeIndex] !== value.trim()) {
      event.preventDefault(); // pick the suggestion; Enter on an exact match submits
      choose(matches[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault(); // close the list, not the dialog
      event.stopPropagation();
      setOpen(false);
    }
  }

  return html`<div class="pl-item">
    <input
      id=${id}
      class="input mono"
      type="text"
      value=${value}
      placeholder="diamond_sword"
      onInput=${(e) => { onChange(e.currentTarget.value); setOpen(true); setActive(0); }}
      onKeyDown=${onKeyDown}
      onBlur=${() => setOpen(false)}
      disabled=${disabled}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded=${showList ? 'true' : 'false'}
      aria-controls=${showList ? listId : undefined}
      aria-activedescendant=${showList ? `${id}-opt-${activeIndex}` : undefined}
      aria-invalid=${invalid ? 'true' : undefined}
      aria-describedby=${describedBy}
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck=${false}
      autofocus
    />
    ${showList &&
    html`<ul id=${listId} class="pl-item-list" role="listbox" aria-label=${t('players.dialog.itemSuggestions')}>
      ${matches.map(
        (item, i) => html`<li
          key=${item}
          id=${`${id}-opt-${i}`}
          role="option"
          aria-selected=${i === activeIndex ? 'true' : 'false'}
          class=${`cl-option ${i === activeIndex ? 'active' : ''}`}
          onMouseDown=${(e) => { e.preventDefault(); choose(item); }}
        >
          <span class="cl-option-label">${item}</span>
        </li>`,
      )}
    </ul>`}
  </div>`;
}

// Errors that belong to no field (a name or mode the page never produces).
const errorText = (code) => t(`players.errors.${code === 'invalid_mode' ? code : 'invalid_player'}`);

function FieldError({ id, code }) {
  if (!code) return null;
  return html`<p id=${id} class="field-error" role="alert">${t(`players.errors.${code}`)}</p>`;
}

export function PlayerDialog({ action, name, others, busy, onSubmit, onClose }) {
  const [values, setValues] = useState({
    reason: '',
    mode: 'survival',
    tpMode: others.length > 0 ? 'player' : 'coords',
    target: others[0] ?? '',
    x: '',
    y: '',
    z: '',
    item: '',
    count: '1',
    message: '',
  });
  const [errors, setErrors] = useState({}); // field -> builder error code

  const set = (field) => (event) => {
    const value = event.currentTarget.value;
    setValues((v) => ({ ...v, [field]: value }));
    setErrors({});
  };
  const setItem = (item) => {
    setValues((v) => ({ ...v, item }));
    setErrors({});
  };

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    let command;
    try {
      command = buildAction(action, name, values);
    } catch (err) {
      const field = errorField(err.message, action);
      setErrors({ [field]: err.message });
      document.getElementById(`pa-${field}`)?.focus();
      return;
    }
    onSubmit(command);
  }

  const danger = action === 'ban';
  const footer = html`
    <button type="button" class="btn btn-secondary" onClick=${onClose} disabled=${busy}>${t('common.cancel')}</button>
    <button type="submit" form=${FORM_ID} class=${`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled=${busy} aria-busy=${busy ? 'true' : undefined}>
      ${busy && html`<span class="spinner" aria-hidden="true"></span>`}${t(`players.dialog.submit.${action}`)}
    </button>
  `;

  let fields;
  if (action === 'kick' || action === 'ban') {
    fields = html`<div class="field">
      <label class="label" for="pa-reason">${t('players.dialog.reason')}</label>
      <input
        id="pa-reason"
        class="input"
        type="text"
        value=${values.reason}
        maxlength=${MAX_TEXT}
        placeholder=${t('players.dialog.reasonPlaceholder')}
        onInput=${set('reason')}
        disabled=${busy}
        autocomplete="off"
        autofocus
      />
    </div>`;
  } else if (action === 'gamemode') {
    fields = html`<div class="field">
      <label class="label" for="pa-mode">${t('players.dialog.mode')}</label>
      <select id="pa-mode" class="select" value=${values.mode} onChange=${set('mode')} disabled=${busy} autofocus>
        ${GAME_MODES.map((mode) => html`<option value=${mode} selected=${mode === values.mode}>${t(`players.modes.${mode}`)}</option>`)}
      </select>
    </div>`;
  } else if (action === 'teleport') {
    const toPlayer = values.tpMode === 'player';
    const switchTo = (tpMode) => {
      setValues((v) => ({ ...v, tpMode }));
      setErrors({});
    };
    fields = html`
      <div class="seg pl-seg" role="group" aria-label=${t('players.dialog.destination')}>
        <button type="button" class=${`seg-btn ${toPlayer ? 'on' : ''}`} aria-pressed=${toPlayer ? 'true' : 'false'} onClick=${() => switchTo('player')} disabled=${busy}>
          ${t('players.dialog.toPlayer')}
        </button>
        <button type="button" class=${`seg-btn ${toPlayer ? '' : 'on'}`} aria-pressed=${toPlayer ? 'false' : 'true'} onClick=${() => switchTo('coords')} disabled=${busy}>
          ${t('players.dialog.toCoords')}
        </button>
      </div>
      ${toPlayer
        ? html`<div class="field">
            <label class="label" for="pa-target">${t('players.dialog.targetPlayer')}</label>
            ${others.length > 0
              ? html`<select
                  id="pa-target"
                  class="select"
                  value=${values.target}
                  onChange=${set('target')}
                  disabled=${busy}
                  aria-invalid=${errors.target ? 'true' : undefined}
                  aria-describedby=${errors.target ? 'pa-target-error' : undefined}
                >
                  ${others.map((p) => html`<option value=${p} selected=${p === values.target}>${p}</option>`)}
                </select>`
              : html`<p class="hint" id="pa-target">${t('players.dialog.noOthers')}</p>`}
            <${FieldError} id="pa-target-error" code=${errors.target} />
          </div>`
        : html`<div class="field">
            <div class="pl-coords" role="group" aria-label=${t('players.dialog.coordinates')} aria-describedby=${errors.coords ? 'pa-coords-error' : 'pa-coords-hint'}>
              ${['x', 'y', 'z'].map(
                (axis, i) => html`<div class="field">
                  <label class="label" for=${i === 0 ? 'pa-coords' : `pa-${axis}`}>${axis.toUpperCase()}</label>
                  <input
                    id=${i === 0 ? 'pa-coords' : `pa-${axis}`}
                    class="input mono"
                    type="text"
                    value=${values[axis]}
                    placeholder="~"
                    onInput=${set(axis)}
                    disabled=${busy}
                    aria-invalid=${errors.coords ? 'true' : undefined}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck=${false}
                    autofocus=${i === 0}
                  />
                </div>`,
              )}
            </div>
            ${errors.coords
              ? html`<${FieldError} id="pa-coords-error" code=${errors.coords} />`
              : html`<p id="pa-coords-hint" class="hint">${t('players.dialog.coordsHint')}</p>`}
          </div>`}
    `;
  } else if (action === 'give') {
    fields = html`
      <div class="field">
        <label class="label" for="pa-item">${t('players.dialog.item')}</label>
        <${ItemPicker}
          id="pa-item"
          value=${values.item}
          onChange=${setItem}
          disabled=${busy}
          invalid=${Boolean(errors.item)}
          describedBy=${errors.item ? 'pa-item-error' : 'pa-item-hint'}
        />
        ${errors.item
          ? html`<${FieldError} id="pa-item-error" code=${errors.item} />`
          : html`<p id="pa-item-hint" class="hint">${t('players.dialog.itemHint')}</p>`}
      </div>
      <div class="field">
        <label class="label" for="pa-count">${t('players.dialog.count')}</label>
        <input
          id="pa-count"
          class="input"
          type="number"
          min="1"
          max=${MAX_GIVE_COUNT}
          step="1"
          inputmode="numeric"
          value=${values.count}
          onInput=${set('count')}
          disabled=${busy}
          aria-invalid=${errors.count ? 'true' : undefined}
          aria-describedby=${errors.count ? 'pa-count-error' : undefined}
        />
        <${FieldError} id="pa-count-error" code=${errors.count} />
      </div>
    `;
  } else {
    fields = html`<div class="field">
      <label class="label" for="pa-message">${t('players.dialog.message')}</label>
      <input
        id="pa-message"
        class="input"
        type="text"
        value=${values.message}
        maxlength=${MAX_TEXT}
        onInput=${set('message')}
        disabled=${busy}
        aria-invalid=${errors.message ? 'true' : undefined}
        aria-describedby=${errors.message ? 'pa-message-error' : undefined}
        autocomplete="off"
        autofocus
      />
      <${FieldError} id="pa-message-error" code=${errors.message} />
    </div>`;
  }

  return html`<${Modal} title=${t(`players.dialog.title.${action}`, { name })} size="sm" onClose=${onClose} busy=${busy} footer=${footer}>
    <form id=${FORM_ID} class="server-form" onSubmit=${submit} noValidate>
      ${fields}
      ${errors.form &&
      html`<div class="alert alert-error" role="alert"><span>${errorText(errors.form)}</span></div>`}
    </form>
  </${Modal}>`;
}
