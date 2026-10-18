// Servers: one card per server (status, players, version) with Open / Edit /
// Delete, an "Add server" card, and the add/edit and delete dialogs.
//
// Status comes from the bulk GET /api/servers/status (polled while the page is
// open). The version is not in that answer, so each online card asks
// GET /api/servers/:id/status once for it (the panel caches that probe for 5 s,
// so it costs no extra ping).
import { html, useEffect, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { setServers, store, useStore } from '../store.js';
import { Empty } from '../components/Empty.js';
import { Icon } from '../components/Icon.js';
import { serverColorVar } from '../components/Layout.js';
import { Modal } from '../components/Modal.js';
import { ServerForm } from '../components/ServerForm.js';
import { toast } from '../components/Toast.js';

const STATUS_POLL_MS = 10_000;

// Reloads the global server list (the Layout's selector reads it). Resolves
// false, after telling the user, when the panel could not be reached.
async function refreshServers() {
  try {
    setServers(await api('/api/servers'));
    return true;
  } catch (err) {
    if (err.status !== 401) toast(t('errors.serversLoad'), { type: 'error' });
    return false;
  }
}

// "Open": make this the server every section works on, then go to the dashboard.
function openServer(server) {
  store.set({ activeServerId: server.id });
  navigate('dashboard');
}

// Welcome shown when there are no servers yet; the Dashboard reuses it.
export function NoServers({ onAdd }) {
  return html`<${Empty}
    icon="servers"
    title=${t('servers.empty.title')}
    message=${t('servers.empty.message')}
    action=${html`<button type="button" class="btn btn-primary" onClick=${onAdd}>
      <${Icon} name="plus" size=${16} />
      ${t('servers.add')}
    </button>`}
  />`;
}

// Status of every server, refreshed every 10 s while mounted and again when the
// set of addresses changes. `null` until the first answer; 'error' if the panel
// could not be asked and nothing is known yet.
function useStatuses(servers) {
  const [statuses, setStatuses] = useState(null);
  const signature = (servers ?? []).map((s) => `${s.id}@${s.host}:${s.gamePort}`).join();
  useEffect(() => {
    if (!signature) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await api('/api/servers/status');
        if (alive) setStatuses(result);
      } catch {
        if (alive) setStatuses((previous) => previous ?? 'error');
      }
    };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [signature]);
  return statuses;
}

function useVersion(server, online) {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    setVersion(null);
    if (!online) return;
    let alive = true;
    api(`/api/servers/${server.id}/status`)
      .then((s) => alive && setVersion(s.version || null))
      .catch(() => {}); // the version is a nicety: the card works without it
    return () => {
      alive = false;
    };
  }, [server.id, server.host, server.gamePort, online]);
  return version;
}

function ServerCard({ server, state, onEdit, onDelete }) {
  // state: undefined while unknown, else { online, players }
  const known = state && typeof state === 'object';
  const status = state === 'error' ? 'unknown' : known ? (state.online ? 'online' : 'offline') : 'checking';
  const online = status === 'online';
  const version = useVersion(server, online);
  const tone = { online: 'pill-online', offline: 'pill-offline' }[status] ?? 'pill-neutral';
  const players = online && state.players ? t('servers.players', { online: state.players.online, max: state.players.max }) : null;

  return html`<li class="card server-card" style=${serverColorVar(server.color)}>
    <div class="server-card-head">
      <span class="server-icon" aria-hidden="true"><${Icon} name=${server.icon} size=${16} /></span>
      <h2 class="server-name" title=${server.name}>${server.name}</h2>
      <span class=${`pill ${tone}`}>
        <span class=${`dot ${status === 'checking' ? 'dot-pulse' : ''}`} aria-hidden="true"></span>
        ${t(`layout.status.${status}`)}
      </span>
    </div>
    <p class="server-addr mono" title=${`${server.host}:${server.rconPort}`}>${server.host}:${server.rconPort}</p>
    <p class="server-meta">
      ${online && html`${players && html`<span>${players}</span>`}${version && html`<span class="server-version" title=${version}>${version}</span>`}`}
      ${status === 'offline' && html`<span>${t('servers.unreachable')}</span>`}
    </p>
    <div class="server-actions">
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => openServer(server)}>
        <${Icon} name="arrowRight" size=${14} />
        ${t('servers.open')}
      </button>
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => onEdit(server)} aria-label=${t('servers.editNamed', { name: server.name })}>
        <${Icon} name="edit" size=${14} />
        ${t('servers.edit')}
      </button>
      <button type="button" class="btn btn-danger btn-sm" onClick=${() => onDelete(server)} aria-label=${t('servers.deleteNamed', { name: server.name })}>
        <${Icon} name="trash" size=${14} />
        ${t('common.delete')}
      </button>
    </div>
  </li>`;
}

// Deleting asks for the exact name. Only the panel's record goes away.
function DeleteServer({ server, onClose, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const matches = typed === server.name;

  async function submit(event) {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await api(`/api/servers/${server.id}`, { method: 'DELETE' });
    } catch (err) {
      if (err.status !== 404) {
        // 404: already gone, which is what was asked for.
        setBusy(false);
        if (err.status !== 401) setFailed(true);
        return;
      }
    }
    onDeleted(server);
  }

  const footer = html`
    <button type="button" class="btn btn-secondary" onClick=${onClose} disabled=${busy}>${t('common.cancel')}</button>
    <button type="submit" form="delete-server-form" class="btn btn-danger" disabled=${!matches || busy} aria-busy=${busy ? 'true' : undefined}>
      ${busy && html`<span class="spinner" aria-hidden="true"></span>`}
      ${t('servers.delete.confirm')}
    </button>
  `;
  return html`<${Modal} title=${t('servers.delete.title', { name: server.name })} size="sm" onClose=${onClose} busy=${busy} footer=${footer}>
    <form id="delete-server-form" class="server-form" onSubmit=${submit} noValidate>
      <p class="confirm-message">${t('servers.delete.message')}</p>
      <div class="field">
        <label class="label" for="delete-server-name">${t('servers.delete.prompt', { name: server.name })}</label>
        <input
          id="delete-server-name"
          class="input"
          type="text"
          value=${typed}
          onInput=${(e) => setTyped(e.currentTarget.value)}
          disabled=${busy}
          autofocus
          autocomplete="off"
          autocapitalize="off"
          spellcheck=${false}
        />
      </div>
      <div class="alert alert-error" role="alert" hidden=${!failed}>
        <${Icon} name="error" size=${16} />
        <span>${t('servers.delete.failed')}</span>
      </div>
    </form>
  </${Modal}>`;
}

export function Servers() {
  const { servers } = useStore();
  const statuses = useStatuses(servers);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialog, setDialog] = useState(null); // null | { type: 'form', server } | { type: 'delete', server }

  // The list is also loaded at sign-in; reload it here so the page is current
  // and can show an error with a retry instead of loading forever.
  async function load() {
    setLoadFailed(false);
    try {
      setServers(await api('/api/servers'));
    } catch (err) {
      if (err.status !== 401) setLoadFailed(true);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const close = () => setDialog(null);

  async function saved(server) {
    const created = dialog.server === null;
    close();
    toast(t(created ? 'servers.toast.created' : 'servers.toast.updated', { name: server.name }));
    await refreshServers();
  }

  async function deleted(server) {
    close();
    toast(t('servers.toast.deleted', { name: server.name }));
    await refreshServers();
  }

  const online = statuses && typeof statuses === 'object' ? servers.filter((s) => statuses[s.id]?.online).length : null;
  let subtitle = null;
  if (servers?.length) {
    const count = t(servers.length === 1 ? 'servers.countOne' : 'servers.count', { count: servers.length });
    subtitle = online === null ? count : `${count} · ${t('servers.onlineCount', { online })}`;
  }

  let body;
  if (servers === null) {
    body = loadFailed
      ? html`<${Empty}
          icon="error"
          title=${t('servers.loadFailed.title')}
          message=${t('servers.loadFailed.message')}
          action=${html`<button type="button" class="btn btn-secondary" onClick=${load}>${t('common.retry')}</button>`}
        />`
      : html`<div class="page-loading" role="status">
          <span class="spinner spinner-lg" aria-hidden="true"></span>
          <span>${t('common.loading')}</span>
        </div>`;
  } else if (servers.length === 0) {
    body = html`<${NoServers} onAdd=${() => setDialog({ type: 'form', server: null })} />`;
  } else {
    body = html`<ul class="server-grid">
      ${servers.map(
        (server) => html`<${ServerCard}
          key=${server.id}
          server=${server}
          state=${statuses === 'error' ? 'error' : statuses?.[server.id]}
          onEdit=${(s) => setDialog({ type: 'form', server: s })}
          onDelete=${(s) => setDialog({ type: 'delete', server: s })}
        />`,
      )}
      <li class="server-add-item">
        <button type="button" class="server-add" onClick=${() => setDialog({ type: 'form', server: null })}>
          <${Icon} name="plus" size=${22} />
          <span>${t('servers.add')}</span>
        </button>
      </li>
    </ul>`;
  }

  return html`<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.servers')}</h1>
        ${subtitle && html`<p class="page-subtitle">${subtitle}</p>`}
      </div>
      ${servers?.length > 0 &&
      html`<button type="button" class="btn btn-primary" onClick=${() => setDialog({ type: 'form', server: null })}>
        <${Icon} name="plus" size=${16} />
        ${t('servers.add')}
      </button>`}
    </header>
    ${body}
    ${dialog?.type === 'form' && html`<${ServerForm} key=${dialog.server?.id ?? 'new'} server=${dialog.server} onClose=${close} onSaved=${saved} />`}
    ${dialog?.type === 'delete' && html`<${DeleteServer} server=${dialog.server} onClose=${close} onDeleted=${deleted} />`}
  </div>`;
}
