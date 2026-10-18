// Shell of a page that works on the active server: renders `view(server)` for
// it, or — with no server yet — the welcome with the "Add server" dialog.
import { html, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { NoServers } from '../pages/Servers.js';
import { activeServer, setServers, store, useStore } from '../store.js';
import { ServerForm } from './ServerForm.js';
import { toast } from './Toast.js';

export function ActiveServer({ titleKey, view }) {
  const state = useStore();
  const server = activeServer(state);
  const [adding, setAdding] = useState(false);

  async function serverAdded(saved) {
    setAdding(false);
    toast(t('servers.toast.created', { name: saved.name }));
    try {
      setServers(await api('/api/servers'));
      store.set({ activeServerId: saved.id });
    } catch (err) {
      if (err.status !== 401) toast(t('errors.serversLoad'), { type: 'error' });
    }
  }

  if (server) return view(server);

  return html`<div class="page">
    <header class="page-head">
      <h1 class="page-title">${t(titleKey)}</h1>
    </header>
    ${state.servers === null
      ? html`<div class="page-loading" role="status">
          <span class="spinner spinner-lg" aria-hidden="true"></span>
          <span>${t('common.loading')}</span>
        </div>`
      : html`<${NoServers} onAdd=${() => setAdding(true)} />`}
    ${adding && html`<${ServerForm} server=${null} onClose=${() => setAdding(false)} onSaved=${serverAdded} />`}
  </div>`;
}
