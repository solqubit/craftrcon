// Dashboard: the live state of the active server at a glance — players, TPS,
// version and ping tiles, the MOTD, a players-over-time chart, a mini console
// with a quick command box, and the players online.
//
// Status arrives over the live socket every 5 s and is also polled (a slower
// fallback for a dropped socket); every poll pauses while the tab is hidden
// and runs again as soon as it is shown. The mini console shares its screen
// with the Console page (lib/screens.js).
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api, openLive } from '../api.js';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useStore } from '../store.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { addLive, addPending, commandProblem, errorKey, failSent, normalizeCommand, resolveSent } from '../lib/console.js';
import { isDangerous } from '../lib/dangerous.js';
import { MINI_CONSOLE_LINES, offlineErrorKey, playersView, tail, tpsLevel, tpsText, versionLabel } from '../lib/dashboard.js';
import { usePolling } from '../lib/polling.js';
import { getScreen, nextSendId, updateScreen } from '../lib/screens.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { Broadcast } from '../components/Broadcast.js';
import { Confirm } from '../components/Confirm.js';
import { Entry } from '../components/ConsoleEntry.js';
import { Empty } from '../components/Empty.js';
import { Head } from '../components/Head.js';
import { Icon } from '../components/Icon.js';
import { LineChart } from '../components/LineChart.js';
import { McText } from '../components/McText.js';

const STATUS_POLL_MS = 10_000;
const PLAYERS_POLL_MS = 30_000;
const SAMPLES_POLL_MS = 60_000;
const RANGES = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
const CHART_HEIGHT = 200;

// ---------- Pieces ----------

function Loading() {
  return html`<div class="page-loading" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span>${t('common.loading')}</span>
  </div>`;
}

function Tiles({ status }) {
  const { players, tps, tpsSupported, version, software, latencyMs } = status;
  const level = tpsSupported && Array.isArray(tps) ? tpsLevel(tps[0]) : null;
  const versionText = versionLabel(version, software);
  return html`<dl class="dash-tiles">
    <div class="card tile">
      <dt class="tile-k">${t('dashboard.tiles.players')}</dt>
      <dd class="tile-v">${players.online}<span class="tile-of">/${players.max}</span></dd>
    </div>
    ${level &&
    html`<div class="card tile">
      <dt class="tile-k">${t('dashboard.tiles.tps')}</dt>
      <dd class=${`tile-v tps-${level}`}>
        ${tpsText(tps[0])}<span class="sr-only"> (${t(`dashboard.tpsLevel.${level}`)})</span>
      </dd>
      <dd class="tile-sub">${t('dashboard.tpsAvg', { five: tpsText(tps[1]), fifteen: tpsText(tps[2]) })}</dd>
    </div>`}
    <div class="card tile">
      <dt class="tile-k">${t('dashboard.tiles.version')}</dt>
      <dd class="tile-v tile-v-text" title=${versionText}>${versionText || '—'}</dd>
    </div>
    <div class="card tile">
      <dt class="tile-k">${t('dashboard.tiles.ping')}</dt>
      <dd class="tile-v">${latencyMs ?? '—'}<span class="tile-unit">${latencyMs != null ? ' ms' : ''}</span></dd>
    </div>
  </dl>`;
}

function Offline({ status, onRetry }) {
  return html`<section class="card dash-offline" aria-labelledby="dash-offline-title">
    <span class="dash-offline-icon" aria-hidden="true"><${Icon} name="error" size=${22} /></span>
    <div class="dash-offline-body">
      <h2 id="dash-offline-title" class="card-title">${t('dashboard.offline.title')}</h2>
      <p class="dash-offline-error">${t(offlineErrorKey(status.error))}</p>
      <p class="hint">${t('dashboard.offline.hint')}</p>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" onClick=${onRetry}>${t('dashboard.offline.retry')}</button>
  </section>`;
}

function ChartCard({ range, onRange, samples, onRetry }) {
  const ready = samples !== null && samples !== 'error' && samples.range === range;
  let body;
  if (samples === 'error') {
    body = html`<div class="alert alert-error" role="alert">
      <${Icon} name="error" size=${16} />
      <span>${t('dashboard.chart.loadFailed')}</span>
      <button type="button" class="btn btn-secondary btn-sm dash-alert-action" onClick=${onRetry}>${t('common.retry')}</button>
    </div>`;
  } else if (!ready) {
    body = html`<div class="dash-chart-state" style=${{ height: `${CHART_HEIGHT}px` }} role="status">
      <span class="spinner" aria-hidden="true"></span><span class="sr-only">${t('common.loading')}</span>
    </div>`;
  } else if (samples.points.length === 0) {
    body = html`<p class="dash-chart-state dash-muted" style=${{ height: `${CHART_HEIGHT}px` }}>${t('dashboard.chart.empty')}</p>`;
  } else {
    body = html`<${LineChart} points=${samples.points} domain=${[samples.from, samples.to]} height=${CHART_HEIGHT} />`;
  }

  return html`<section class="card" aria-labelledby="dash-chart-title">
    <div class="card-head">
      <h2 id="dash-chart-title" class="card-title">${t('dashboard.chart.title')}</h2>
      <div class="seg" role="group" aria-label=${t('dashboard.chart.range')}>
        ${Object.keys(RANGES).map(
          (key) => html`<button type="button" class=${`seg-btn ${key === range ? 'on' : ''}`} aria-pressed=${key === range ? 'true' : 'false'} onClick=${() => onRange(key)}>
            ${t(`dashboard.chart.range${key}`)}
          </button>`,
        )}
      </div>
    </div>
    ${body}
  </section>`;
}

function MiniConsole({ entries, dangerous, serverId, update, lang }) {
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const outRef = useRef(null);
  const shown = tail(entries, MINI_CONSOLE_LINES);

  useLayoutEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  async function execute(command) {
    const sendId = nextSendId();
    update((log) => addPending(log, { id: sendId, command, ts: Date.now() }));
    setInput('');
    try {
      const result = await api(`/api/servers/${serverId}/command`, { method: 'POST', body: { command, origin: 'console' } });
      update((log) => resolveSent(log, sendId, command, result));
    } catch (err) {
      update((log) => failSent(log, sendId, err.status === 404 ? 'not_found' : err.code));
    }
  }

  function submit(event) {
    event.preventDefault();
    const problem = commandProblem(input);
    if (problem === 'empty') return;
    if (problem) {
      setInputError(problem);
      return;
    }
    const command = normalizeCommand(input);
    if (isDangerous(command, dangerous)) setConfirm(command);
    else execute(command);
  }

  return html`<section class="card dash-console" aria-labelledby="dash-console-title">
    <div class="card-head">
      <h2 id="dash-console-title" class="card-title">${t('dashboard.console.title')}</h2>
      <a class="dash-link" href=${href('console')}>${t('dashboard.console.open')}<${Icon} name="arrowRight" size=${14} /></a>
    </div>
    <div class="cl-term dash-term">
      <div ref=${outRef} class="cl-out dash-out" role="log" aria-label=${t('console.outputLabel')} data-lang=${lang}>
        ${shown.length === 0
          ? html`<p class="dash-muted dash-console-empty">${t('dashboard.console.empty')}</p>`
          : shown.map((e) => html`<${Entry} key=${e.id != null ? `s${e.id}` : e.key} entry=${e} />`)}
      </div>
      <form class="cl-input-row" onSubmit=${submit}>
        <span class="cl-prompt" aria-hidden="true">›</span>
        <input
          class="cl-input"
          type="text"
          value=${input}
          placeholder=${t('console.placeholder')}
          onInput=${(e) => { setInput(e.currentTarget.value); setInputError(null); }}
          aria-label=${t('dashboard.console.input')}
          aria-invalid=${inputError ? 'true' : undefined}
          aria-describedby=${inputError ? 'dash-console-error' : undefined}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck=${false}
          enterkeyhint="send"
        />
        <button type="submit" class="btn btn-primary btn-sm cl-send" disabled=${input.trim() === ''}>
          <span>${t('console.send')}</span><${Icon} name="enter" size=${14} />
        </button>
      </form>
    </div>
    ${inputError && html`<p id="dash-console-error" class="cl-input-error dash-input-error" role="alert">${t(errorKey(inputError))}</p>`}
    ${confirm &&
    html`<${Confirm}
      title=${t('console.confirm.title')}
      message=${html`<p class="confirm-message">${t('console.confirm.message')}</p>
        <code class="cl-confirm-cmd">${confirm}</code>
        <p class="hint">${t('console.confirm.hint')}</p>`}
      confirmLabel=${t('console.confirm.run')}
      danger
      onConfirm=${() => { const command = confirm; setConfirm(null); execute(command); }}
      onCancel=${() => setConfirm(null)}
    />`}
  </section>`;
}

function PlayersCard({ players, onRetry }) {
  const view = players === null || players === 'error' ? null : playersView(players);
  let body;
  if (players === null) body = html`<div class="dash-chart-state" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">${t('common.loading')}</span></div>`;
  else if (players === 'error') {
    body = html`<div class="dash-players-state">
      <p class="dash-muted">${t('dashboard.players.loadFailed')}</p>
      <button type="button" class="btn btn-secondary btn-sm" onClick=${onRetry}>${t('common.retry')}</button>
    </div>`;
  } else if (view?.kind === 'list' && view.names.length > 0) {
    body = html`<ul class="dash-players">
      ${view.names.map((name) => html`<li key=${name} class="dash-player"><${Head} name=${name} size=${20} /><span class="dash-player-name">${name}</span></li>`)}
    </ul>`;
  } else if (view?.kind === 'raw') {
    body = html`<div><p class="dash-muted">${t('dashboard.players.raw')}</p><p class="dash-raw mono"><${McText} text=${view.raw} /></p></div>`;
  } else {
    body = html`<p class="dash-muted dash-players-state">${t('dashboard.players.empty')}</p>`;
  }
  return html`<section class="card dash-players-card" aria-labelledby="dash-players-title">
    <div class="card-head">
      <h2 id="dash-players-title" class="card-title">${t('dashboard.players.title')}</h2>
    </div>
    ${body}
  </section>`;
}

// Opens the announcement editor (the same modal as the World page).
function BroadcastCard({ onOpen }) {
  return html`<section class="card dash-broadcast" aria-labelledby="dash-broadcast-title">
    <div class="dash-broadcast-body">
      <h2 id="dash-broadcast-title" class="card-title">${t('broadcast.card.title')}</h2>
      <p class="dash-muted">${t('broadcast.card.text')}</p>
    </div>
    <button type="button" class="btn btn-primary btn-sm" onClick=${onOpen}>${t('broadcast.open')}</button>
  </section>`;
}

// ---------- Page ----------

function DashboardView({ server }) {
  const { lang } = useStore();
  const id = server.id;

  const [status, setStatus] = useState(null); // null (loading) | 'error' | the /status answer
  const [players, setPlayers] = useState(null); // null | 'error' | the /players answer
  const [samples, setSamples] = useState(null); // null | 'error' | { range, from, to, points }
  const [range, setRange] = useState('24h');
  const [entries, setEntries] = useState(() => getScreen(id));
  const [dangerous, setDangerous] = useState(DEFAULT_DANGEROUS_COMMANDS);
  const [broadcasting, setBroadcasting] = useState(false);

  const update = (change) => {
    const previous = getScreen(id);
    const next = updateScreen(id, change);
    if (next !== previous) setEntries(next);
  };

  useEffect(() => {
    api('/api/settings/dangerous-commands')
      .then((list) => Array.isArray(list) && setDangerous(list))
      .catch(() => {}); // keep the defaults: better one confirmation too many
    return openLive(id, (message) => {
      if (message?.type === 'status' && message.status) setStatus(message.status);
      else if (message?.type === 'console' && message.entry) update((log) => addLive(log, message.entry));
    });
  }, [id]);

  async function loadStatus(isCurrent = () => true) {
    try {
      const result = await api(`/api/servers/${id}/status`);
      if (isCurrent()) setStatus(result);
    } catch (err) {
      if (isCurrent() && err.status !== 401) setStatus((previous) => (previous && previous !== 'error' ? previous : 'error'));
    }
  }
  usePolling(loadStatus, STATUS_POLL_MS, [id]);

  const online = status !== null && status !== 'error' && status.online === true;
  const count = online ? status.players?.online : null;

  // The names follow the player count, plus a slow refresh for name swaps.
  async function loadPlayers(isCurrent = () => true) {
    if (!online) return;
    try {
      const result = await api(`/api/servers/${id}/players`);
      if (isCurrent()) setPlayers(result);
    } catch (err) {
      if (isCurrent() && err.status !== 401) setPlayers((previous) => (previous && previous !== 'error' ? previous : 'error'));
    }
  }
  usePolling(loadPlayers, PLAYERS_POLL_MS, [id, online, count]);

  async function loadSamples(isCurrent = () => true) {
    try {
      const points = await api(`/api/servers/${id}/samples?range=${range}`);
      if (!isCurrent()) return;
      const to = Math.max(Date.now(), points.at(-1)?.ts ?? 0);
      setSamples({ range, from: to - RANGES[range], to, points });
    } catch (err) {
      if (isCurrent() && err.status !== 401) setSamples((previous) => (previous?.range === range ? previous : 'error'));
    }
  }
  usePolling(loadSamples, SAMPLES_POLL_MS, [id, range]);

  let body;
  if (status === null) body = html`<${Loading} />`;
  else if (status === 'error') {
    body = html`<${Empty}
      icon="error"
      title=${t('dashboard.loadFailed.title')}
      message=${t('dashboard.loadFailed.message')}
      action=${html`<button type="button" class="btn btn-secondary" onClick=${() => { setStatus(null); loadStatus(); }}>${t('common.retry')}</button>`}
    />`;
  } else {
    const chart = html`<${ChartCard} range=${range} onRange=${setRange} samples=${samples} onRetry=${() => { setSamples(null); loadSamples(); }} />`;
    body = status.online
      ? html`<${Tiles} status=${status} />
          ${status.motd && html`<section class="card dash-motd" aria-label=${t('dashboard.motd')}><${McText} text=${status.motd} /></section>`}
          ${chart}
          <div class="dash-row">
            <${MiniConsole} entries=${entries} dangerous=${dangerous} serverId=${id} update=${update} lang=${lang} />
            <${PlayersCard} players=${players} onRetry=${() => { setPlayers(null); loadPlayers(); }} />
          </div>
          <${BroadcastCard} onOpen=${() => setBroadcasting(true)} />
          ${broadcasting && html`<${Broadcast} server=${server} version=${status.version ?? ''} onClose=${() => setBroadcasting(false)} />`}`
      : html`<${Offline} status=${status} onRetry=${() => { setStatus(null); loadStatus(); }} />${chart}`;
  }

  return html`<div class="page dash">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.dashboard')}</h1>
        <p class="page-subtitle">${t('dashboard.subtitle', { name: server.name })}</p>
      </div>
    </header>
    ${body}
  </div>`;
}

export function Dashboard() {
  return html`<${ActiveServer} titleKey="nav.dashboard" view=${(server) => html`<${DashboardView} key=${server.id} server=${server} />`} />`;
}
