// Entry point: loads the language, checks the session and renders the app.
import { html, render, useEffect } from '../vendor/htm-preact.js';
import { api } from './api.js';
import { getLang, setLang, t } from './i18n.js';
import { useRoute } from './router.js';
import { setServers, store, useStore } from './store.js';
import { Empty } from './components/Empty.js';
import { Layout } from './components/Layout.js';
import { Toasts, toast } from './components/Toast.js';
import { Console } from './pages/Console.js';
import { Dashboard } from './pages/Dashboard.js';
import { Login } from './pages/Login.js';
import { Servers } from './pages/Servers.js';

// Section pages by route name. Later tasks register theirs here; until then a
// section shows a placeholder.
const PAGES = { dashboard: Dashboard, console: Console, servers: Servers };

function Placeholder({ route }) {
  return html`<div class="page">
    <header class="page-head">
      <h1 class="page-title">${t(`nav.${route}`)}</h1>
    </header>
    <${Empty} icon=${route} title=${t('placeholder.title')} message=${t('placeholder.message')} />
  </div>`;
}

function Splash() {
  return html`<div class="splash" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span class="sr-only">${t('common.loading')}</span>
  </div>`;
}

function App() {
  const state = useStore();
  const route = useRoute();

  useEffect(() => {
    if (!state.authenticated) return;
    api('/api/servers')
      .then(setServers)
      .catch((err) => {
        if (err.status !== 401) toast(t('errors.serversLoad'), { type: 'error' });
      });
  }, [state.authenticated]);

  useEffect(() => {
    document.title = state.authenticated ? `${t(`nav.${route}`)} · CraftRCON` : 'CraftRCON';
  }, [state.authenticated, route, state.lang]);

  let screen;
  if (state.authenticated === null) screen = html`<${Splash} />`;
  else if (!state.authenticated) screen = html`<${Login} />`;
  else {
    const Page = PAGES[route] ?? Placeholder;
    screen = html`<${Layout} route=${route}><${Page} key=${route} route=${route} /></${Layout}>`;
  }
  return html`${screen}<${Toasts} />`;
}

async function boot() {
  try {
    await setLang(getLang());
  } catch {
    // Locale files unreachable: t() falls back to the keys themselves.
  }
  store.set({ lang: getLang() });
  render(html`<${App} />`, document.getElementById('app'));

  try {
    await api('/api/me');
    store.set({ authenticated: true });
  } catch {
    store.set({ authenticated: false });
  }
}

boot();
