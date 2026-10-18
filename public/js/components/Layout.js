// App frame: sidebar (brand, server picker, sections, log out) and a top bar
// (active server, language, Online/Offline). Below 768 px the sidebar becomes
// a drop-down menu opened from the top bar.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { LANGUAGES, getLang, setLang, t } from '../i18n.js';
import { ROUTES, href } from '../router.js';
import { activeServer, store, useStore } from '../store.js';
import { Icon } from './Icon.js';
import { toast } from './Toast.js';

const STATUS_POLL_MS = 10_000;

// Server accent colors (the `color` field of a server) as CSS custom properties.
export const serverColorVar = (color) => ({ '--srv': `var(--c-${color ?? 'emerald'})` });

export function Brand() {
  return html`<span class="brand">
    <span class="brand-mark" aria-hidden="true">⛏</span>
    <span class="brand-name"><span class="brand-accent">Craft</span>RCON</span>
  </span>`;
}

export function LangSelect() {
  const lang = useStore().lang;
  const onChange = async (event) => {
    const select = event.currentTarget; // currentTarget is gone after the await
    try {
      await setLang(select.value);
      store.set({ lang: getLang() });
    } catch {
      select.value = lang;
      toast(t('errors.network'), { type: 'error' });
    }
  };
  return html`<label class="lang-select" title=${t('layout.language')}>
    <span class="sr-only">${t('layout.language')}</span>
    <select value=${lang} onChange=${onChange}>
      ${LANGUAGES.map((l) => html`<option value=${l.code} lang=${l.code}>${l.code.toUpperCase()}</option>`)}
    </select>
    <${Icon} name="chevronDown" size=${14} />
  </label>`;
}

// 'checking' until the first answer, then 'online' | 'offline' | 'unknown'
// (the panel itself could not be asked). Polls while mounted.
function useServerStatus(serverId) {
  const [status, setStatus] = useState('checking');
  useEffect(() => {
    setStatus('checking');
    if (serverId === null) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await api(`/api/servers/${serverId}/status`);
        if (alive) setStatus(result.online ? 'online' : 'offline');
      } catch {
        if (alive) setStatus('unknown');
      }
    };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [serverId]);
  return status;
}

function StatusPill({ serverId }) {
  const status = useServerStatus(serverId);
  const tone = { online: 'pill-online', offline: 'pill-offline' }[status] ?? 'pill-neutral';
  return html`<span class=${`pill ${tone}`}>
    <span class=${`dot ${status === 'checking' ? 'dot-pulse' : ''}`} aria-hidden="true"></span>
    ${t(`layout.status.${status}`)}
  </span>`;
}

function ServerPicker({ servers, activeServerId }) {
  if (servers === null) {
    return html`<div class="server-picker">
      <span class="picker-label">${t('layout.server')}</span>
      <div class="picker picker-loading" aria-hidden="true"></div>
    </div>`;
  }
  if (servers.length === 0) {
    return html`<div class="server-picker">
      <span class="picker-label">${t('layout.server')}</span>
      <a class="picker picker-empty" href=${href('servers')}>
        <${Icon} name="plus" size=${16} />
        <span>${t('layout.noServers')}</span>
      </a>
    </div>`;
  }
  const active = servers.find((s) => s.id === activeServerId);
  const onChange = (event) => store.set({ activeServerId: Number(event.currentTarget.value) });
  return html`<div class="server-picker">
    <label class="picker-label" for="server-select">${t('layout.server')}</label>
    <div class="picker" style=${serverColorVar(active?.color)}>
      <span class="picker-dot" aria-hidden="true"></span>
      <select id="server-select" value=${String(activeServerId)} onChange=${onChange}>
        ${servers.map((s) => html`<option value=${String(s.id)}>${s.name}</option>`)}
      </select>
      <${Icon} name="chevronDown" size=${16} class="picker-chevron" />
    </div>
  </div>`;
}

export function Layout({ route, children }) {
  const state = useStore();
  const server = activeServer(state);
  const [menuOpen, setMenuOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const menuButton = useRef(null);
  const main = useRef(null);

  // Picking a section (or a server) closes the mobile menu.
  useEffect(() => setMenuOpen(false), [route, state.activeServerId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  async function logout() {
    setLeaving(true);
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (err) {
      if (err.status !== 401) {
        toast(t('errors.logoutFailed'), { type: 'error' });
        setLeaving(false);
        return;
      }
    }
    store.set({ authenticated: false, servers: null });
  }

  const skipToContent = () => main.current?.focus();

  return html`<div class=${`shell ${menuOpen ? 'menu-open' : ''}`}>
    <button type="button" class="skip-link" onClick=${skipToContent}>${t('layout.skip')}</button>

    <header class="topbar">
      <button
        ref=${menuButton}
        type="button"
        class="icon-btn menu-btn"
        aria-controls="sidebar"
        aria-expanded=${menuOpen ? 'true' : 'false'}
        aria-label=${t(menuOpen ? 'nav.closeMenu' : 'nav.openMenu')}
        onClick=${() => setMenuOpen(!menuOpen)}
      >
        <${Icon} name=${menuOpen ? 'close' : 'menu'} size=${20} />
      </button>
      <a class="topbar-brand" href=${href('dashboard')}><${Brand} /></a>
      <div class="topbar-server">
        ${server &&
        html`<span class="server-badge" style=${serverColorVar(server.color)} aria-hidden="true"></span>
          <span class="topbar-server-name">${server.name}</span>
          <span class="topbar-server-addr mono">${server.host}:${server.gamePort}</span>`}
      </div>
      <div class="topbar-actions">
        <${LangSelect} />
        ${server && html`<${StatusPill} key=${server.id} serverId=${server.id} />`}
      </div>
    </header>

    <aside id="sidebar" class="sidebar">
      <a class="sidebar-brand" href=${href('dashboard')}><${Brand} /></a>
      <${ServerPicker} servers=${state.servers} activeServerId=${state.activeServerId} />
      <nav class="nav" aria-label=${t('nav.label')}>
        <ul>
          ${ROUTES.map(
            (name) => html`<li key=${name}>
              <a
                class=${`nav-item ${name === route ? 'active' : ''}`}
                href=${href(name)}
                aria-current=${name === route ? 'page' : undefined}
              >
                <${Icon} name=${name} />
                <span>${t(`nav.${name}`)}</span>
              </a>
            </li>`,
          )}
        </ul>
      </nav>
      <div class="sidebar-foot">
        <button type="button" class="nav-item" onClick=${logout} disabled=${leaving}>
          <${Icon} name="logout" />
          <span>${t('layout.logout')}</span>
        </button>
      </div>
    </aside>
    <div class="menu-backdrop" aria-hidden="true" onClick=${() => setMenuOpen(false)}></div>

    <main id="main" class="content" ref=${main} tabindex="-1">${children}</main>
  </div>`;
}
