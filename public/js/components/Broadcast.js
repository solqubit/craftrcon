// Broadcast editor: a modal to write an announcement for everyone on the active
// server. The message is typed with '&' codes (the color and format buttons
// insert them at the cursor), shown in a live preview and sent as `tellraw`
// (colors and formats) or `say` (plain). Reused by World and Dashboard.
//
//   <${Broadcast} server=${server} version=${status.version} onClose=${close} />
//
// `version` (the server's version text) decides between JSON and SNBT for
// `tellraw`; when it isn't given the editor asks /status itself.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  BROADCAST_MODES, COLOR_BUTTONS, FORMAT_BUTTONS,
  broadcastCommand, insertCode, loadMode, remainingBytes, saveMode,
} from '../lib/broadcast.js';
import { oneLine } from '../lib/names.js';
import { useCommandRunner } from './CommandRunner.js';
import { McText } from './McText.js';
import { Modal } from './Modal.js';

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined; // storage blocked
  }
};

// The server version for `tellraw`: the one given, else asked from /status.
// { loading, version } with version '' when it can't be known.
function useVersion(serverId, given) {
  const [found, setFound] = useState(null);
  useEffect(() => {
    if (given != null) return undefined;
    let current = true;
    api(`/api/servers/${serverId}/status`)
      .then((status) => current && setFound(typeof status?.version === 'string' ? status.version : ''))
      .catch(() => current && setFound(''));
    return () => {
      current = false;
    };
  }, [serverId, given]);
  if (given != null) return { loading: false, version: given };
  return { loading: found === null, version: found ?? '' };
}

export function Broadcast({ server, version: givenVersion, onClose }) {
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState(() => loadMode(storage()));
  const { send, busy, confirmDialog } = useCommandRunner(server.id);
  const { loading, version } = useVersion(server.id, givenVersion);
  const area = useRef(null);
  const cursor = useRef(null); // where the cursor goes after a code was inserted

  useLayoutEffect(() => {
    if (cursor.current === null || !area.current) return;
    area.current.setSelectionRange(cursor.current, cursor.current);
    cursor.current = null;
  }, [message]);

  function pickMode(next) {
    setMode(next);
    saveMode(storage(), next);
  }

  function insert(code) {
    const el = area.current;
    const result = insertCode(message, el?.selectionStart, el?.selectionEnd, code);
    cursor.current = result.cursor;
    setMessage(result.text);
    el?.focus();
  }

  const rich = mode === 'tellraw';
  const command = broadcastCommand(mode, message, { version });
  const left = remainingBytes(command);
  const tooLong = left < 0;
  const canSend = command !== null && !tooLong && !busy && !(rich && loading);

  async function submit() {
    if (!canSend) return;
    if (await send(command)) onClose();
  }

  const preview = oneLine(message);
  const footer = html`
    <button type="button" class="btn btn-secondary" onClick=${onClose} disabled=${busy}>${t('common.cancel')}</button>
    <button type="button" class="btn btn-primary" onClick=${submit} disabled=${!canSend} aria-busy=${busy ? 'true' : undefined}>
      ${busy && html`<span class="spinner" aria-hidden="true"></span>`}${t('broadcast.send')}
    </button>
  `;

  return html`<${Modal} title=${t('broadcast.title')} onClose=${onClose} busy=${busy} footer=${footer} size="lg">
      <div class="bc">
        <fieldset class="bc-modes">
          <legend class="label">${t('broadcast.mode')}</legend>
          ${BROADCAST_MODES.map(
            (name) => html`<label key=${name} class=${`bc-mode ${mode === name ? 'on' : ''}`}>
              <input type="radio" name="bc-mode" value=${name} checked=${mode === name} onChange=${() => pickMode(name)} />
              <span>${t(`broadcast.modes.${name}`)}</span>
            </label>`,
          )}
        </fieldset>
        <p class="hint">${t(`broadcast.modeHint.${mode}`)}</p>

        <div class="bc-tools">
          <div class="bc-group" role="group" aria-label=${t('broadcast.colors')}>
            ${COLOR_BUTTONS.map(
              ({ code, name, hex }) => html`<button
                key=${code}
                type="button"
                class="bc-swatch"
                style=${{ background: hex }}
                title=${t(`broadcast.colorNames.${name}`)}
                aria-label=${t(`broadcast.colorNames.${name}`)}
                disabled=${!rich}
                onClick=${() => insert(code)}
              ></button>`,
            )}
          </div>
          <div class="bc-group" role="group" aria-label=${t('broadcast.formats')}>
            ${FORMAT_BUTTONS.map(
              ({ code, name }) => html`<button
                key=${code}
                type="button"
                class=${`btn btn-secondary btn-sm bc-fmt bc-fmt-${name}`}
                disabled=${!rich}
                onClick=${() => insert(code)}
              >
                ${t(`broadcast.format.${name}`)}
              </button>`,
            )}
          </div>
        </div>

        <div class="field">
          <label class="label" for="bc-message">${t('broadcast.message')}</label>
          <textarea
            id="bc-message"
            ref=${area}
            class="textarea mono"
            rows="4"
            value=${message}
            placeholder=${t('broadcast.placeholder')}
            onInput=${(e) => setMessage(e.currentTarget.value)}
            aria-invalid=${tooLong ? 'true' : undefined}
            aria-describedby="bc-bytes"
            autocomplete="off"
            spellcheck=${false}
          ></textarea>
          <p id="bc-bytes" class=${`hint bc-bytes ${tooLong ? 'over' : ''}`} role=${tooLong ? 'alert' : undefined}>
            ${tooLong ? t('broadcast.bytesOver', { count: -left }) : t('broadcast.bytesLeft', { count: left })}
          </p>
        </div>

        <div class="field">
          <span class="label">${t('broadcast.preview')}</span>
          <div class="bc-preview" aria-live="polite">
            ${preview.trim() === ''
              ? html`<span class="bc-preview-empty">${t('broadcast.previewEmpty')}</span>`
              : rich
                ? html`<${McText} text=${preview} ampersand />`
                : html`<span class="bc-say">[Server] ${preview}</span>`}
          </div>
        </div>

        ${rich && loading && html`<p class="hint" role="status">${t('broadcast.versionLoading')}</p>`}
        ${rich && !loading && version === '' && html`<p class="hint" role="status">${t('broadcast.versionUnknown')}</p>`}
      </div>
    </${Modal}>
    ${confirmDialog}`;
}
