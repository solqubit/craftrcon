// Players: the players online on the active server, each with a menu of quick
// actions (kick, ban, op, gamemode, teleport, give, message, whitelist).
//
// The list is polled every 5 s while the tab is visible. Actions run through
// POST /command with origin 'ui' (they go to the audit log, not to the console
// history); the server's reply comes back as a toast. A command on the
// configurable "dangerous" list asks for confirmation first (all of that lives
// in useCommandRunner).
import { html, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { errorKey } from '../lib/console.js';
import { isValidPlayerName } from '../lib/names.js';
import { playersView } from '../lib/dashboard.js';
import { DIALOG_ACTIONS, buildAction } from '../lib/players.js';
import { usePolling } from '../lib/polling.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { useCommandRunner } from '../components/CommandRunner.js';
import { Empty } from '../components/Empty.js';
import { Head } from '../components/Head.js';
import { Icon } from '../components/Icon.js';
import { McText } from '../components/McText.js';
import { PlayerDialog } from '../components/PlayerDialog.js';
import { PlayerMenu } from '../components/PlayerMenu.js';
import { toast } from '../components/Toast.js';

const POLL_MS = 5000;

function Loading() {
  return html`<div class="page-loading" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span>${t('common.loading')}</span>
  </div>`;
}

function PlayersView({ server }) {
  const id = server.id;
  const [data, setData] = useState(null); // the last /players answer
  const [error, setError] = useState(null); // code of the last failed load
  const [flow, setFlow] = useState(null); // { action, name }: a dialog is open
  const { send: runCommand, busy, confirmDialog } = useCommandRunner(id);

  async function load(isCurrent = () => true) {
    try {
      const result = await api(`/api/servers/${id}/players`);
      if (!isCurrent()) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (isCurrent() && err.status !== 401) setError(err.status === 404 ? 'not_found' : err.code);
    }
  }
  usePolling(load, POLL_MS, [id]);

  // Sends the command; the dialog closes when it went through and stays open
  // (to try again) when it did not.
  async function send(command) {
    if (await runCommand(command)) {
      setFlow(null);
      load();
    }
  }

  function choose(action, name) {
    if (DIALOG_ACTIONS.includes(action)) {
      setFlow({ action, name });
      return;
    }
    try {
      send(buildAction(action, name));
    } catch {
      toast(t('players.errors.invalid_player'), { type: 'error' });
    }
  }

  const view = data === null ? null : playersView(data);
  const names = view?.kind === 'list' ? view.names : [];
  const total = view?.kind === 'list' ? (Number.isInteger(data.online) ? data.online : names.length) : null;

  let body;
  if (data === null && error === null) body = html`<${Loading} />`;
  else if (data === null) {
    body = html`<${Empty}
      icon="error"
      title=${t('players.loadFailed.title')}
      message=${t(errorKey(error))}
      action=${html`<button type="button" class="btn btn-secondary" onClick=${() => { setError(null); load(); }}>${t('common.retry')}</button>`}
    />`;
  } else if (view?.kind === 'raw') {
    body = html`<section class="card" aria-labelledby="pl-raw-title">
      <h2 id="pl-raw-title" class="card-title">${t('players.raw.title')}</h2>
      <p class="hint">${t('players.raw.hint')}</p>
      <p class="dash-raw mono"><${McText} text=${view.raw} /></p>
    </section>`;
  } else if (names.length === 0) {
    body = html`<${Empty} icon="players" title=${t('players.empty.title')} message=${t('players.empty.message', { name: server.name })} />`;
  } else {
    body = html`<section class="card pl-card" aria-label=${t('players.listLabel')}>
      <ul class="pl-list">
        ${names.map(
          (name) => html`<li key=${name} class="pl-row">
            <${Head} name=${name} size=${28} />
            <span class="pl-name">${name}</span>
            <${PlayerMenu} name=${name} disabled=${!isValidPlayerName(name)} onSelect=${(action) => choose(action, name)} />
          </li>`,
        )}
      </ul>
    </section>`;
  }

  return html`<div class="page pl">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.players')}</h1>
        <p class="page-subtitle">${t('players.subtitle', { name: server.name })}</p>
      </div>
      ${total !== null &&
      html`<p class="pl-count" role="status">
        <${Icon} name="players" size=${16} />
        ${Number.isInteger(data.max) ? t('players.count', { online: total, max: data.max }) : t('players.countOnly', { online: total })}
      </p>`}
    </header>
    ${error !== null &&
    data !== null &&
    html`<div class="alert alert-warn" role="alert">
      <${Icon} name="warn" size=${16} />
      <span>${t('players.refreshFailed', { reason: t(errorKey(error)) })}</span>
    </div>`}
    ${body}
    ${flow &&
    html`<${PlayerDialog}
      action=${flow.action}
      name=${flow.name}
      others=${names.filter((n) => n !== flow.name && isValidPlayerName(n))}
      busy=${busy}
      onSubmit=${send}
      onClose=${() => setFlow(null)}
    />`}
    ${confirmDialog}
  </div>`;
}

export function Players() {
  return html`<${ActiveServer} titleKey="nav.players" view=${(server) => html`<${PlayersView} key=${server.id} server=${server} />`} />`;
}
