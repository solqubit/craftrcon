// Players: the players online on the active server, each with a menu of quick
// actions (kick, ban, op, gamemode, teleport, give, message, whitelist).
//
// The list is polled every 5 s while the tab is visible. Actions run through
// POST /command with origin 'ui' (they go to the audit log, not to the console
// history); the server's reply comes back as a toast. A command on the
// configurable "dangerous" list asks for confirmation first.
import { html, useEffect, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { errorKey } from '../lib/console.js';
import { isDangerous } from '../lib/dangerous.js';
import { isValidPlayerName } from '../lib/names.js';
import { playersView } from '../lib/dashboard.js';
import { DIALOG_ACTIONS, buildAction } from '../lib/players.js';
import { usePolling } from '../lib/polling.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { Confirm } from '../components/Confirm.js';
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
  const [dangerous, setDangerous] = useState(DEFAULT_DANGEROUS_COMMANDS);
  const [flow, setFlow] = useState(null); // { action, name }: a dialog is open
  const [confirm, setConfirm] = useState(null); // the dangerous command awaiting a yes
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/settings/dangerous-commands')
      .then((list) => Array.isArray(list) && setDangerous(list))
      .catch(() => {}); // keep the defaults: better one confirmation too many
  }, []);

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

  // Sends the command; closes the dialog and the confirmation when it went
  // through, and keeps the dialog open (to try again) when it did not.
  async function run(command) {
    setBusy(true);
    let sent = false;
    try {
      const result = await api(`/api/servers/${id}/command`, { method: 'POST', body: { command, origin: 'ui' } });
      if (result.ok) {
        sent = true;
        const reply = typeof result.output === 'string' ? result.output.trim() : '';
        if (reply) toast(html`<${McText} text=${reply} />`, { type: 'info' });
        else toast(t('players.toast.sent'));
      } else {
        toast(t(errorKey(result.error)), { type: 'error' });
      }
    } catch (err) {
      if (err.status !== 401) toast(t(errorKey(err.status === 404 ? 'not_found' : err.code)), { type: 'error' });
    }
    setBusy(false);
    setConfirm(null);
    if (sent) {
      setFlow(null);
      load();
    }
  }

  // Runs `command` now, or after the user confirms when it is on the list.
  function send(command) {
    if (isDangerous(command, dangerous)) setConfirm(command);
    else run(command);
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
    ${confirm &&
    html`<${Confirm}
      title=${t('console.confirm.title')}
      message=${html`<p class="confirm-message">${t('console.confirm.message')}</p>
        <code class="cl-confirm-cmd">${confirm}</code>
        <p class="hint">${t('console.confirm.hint')}</p>`}
      confirmLabel=${t('console.confirm.run')}
      danger
      busy=${busy}
      onConfirm=${() => run(confirm)}
      onCancel=${() => setConfirm(null)}
    />`}
  </div>`;
}

export function Players() {
  return html`<${ActiveServer} titleKey="nav.players" view=${(server) => html`<${PlayersView} key=${server.id} server=${server} />`} />`;
}
