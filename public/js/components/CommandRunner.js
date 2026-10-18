// Sends commands to the active server from a page (Players, Moderation):
//
//   const { send, busy, confirmDialog, lastReply } = useCommandRunner(server.id);
//   const sent = await send('ban Steve', ask?);   // true when the server took it
//   lastReply.current: the text the server answered to the last command that went through
//   ... render ${confirmDialog} somewhere in the page ...
//
// It owns the dangerous-commands list (fetched once, defaults on failure), the
// confirmation of a command on that list, the POST to /command with origin
// 'ui' (audit log, not console history) and the toast: the server's reply, or
// the translated error. `ask` ({ title, message, label, danger }) makes a
// command that isn't on the list ask for confirmation too.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { commandReply, confirmationFor, failureCode } from '../lib/commands.js';
import { errorKey } from '../lib/console.js';
import { Confirm } from './Confirm.js';
import { McText } from './McText.js';
import { toast } from './Toast.js';

export function useCommandRunner(serverId) {
  const [dangerous, setDangerous] = useState(DEFAULT_DANGEROUS_COMMANDS);
  const [pending, setPending] = useState(null); // { command, ask, resolve }: awaiting a yes
  const [busy, setBusy] = useState(false);
  const lastReply = useRef('');

  useEffect(() => {
    api('/api/settings/dangerous-commands')
      .then((list) => Array.isArray(list) && setDangerous(list))
      .catch(() => {}); // keep the defaults: better one confirmation too many
  }, []);

  async function execute(command) {
    setBusy(true);
    let sent = false;
    try {
      const result = await api(`/api/servers/${serverId}/command`, { method: 'POST', body: { command, origin: 'ui' } });
      if (result.ok) {
        sent = true;
        const reply = commandReply(result);
        lastReply.current = reply;
        if (reply) toast(html`<${McText} text=${reply} />`, { type: 'info' });
        else toast(t('common.commandSent'));
      } else {
        toast(t(errorKey(result.error)), { type: 'error' });
      }
    } catch (err) {
      if (err.status !== 401) toast(t(errorKey(failureCode(err))), { type: 'error' });
    }
    setBusy(false);
    return sent;
  }

  // Resolves true once the command went through; false when it failed or the
  // user said no.
  function send(command, ask) {
    return new Promise((resolve) => {
      const need = confirmationFor(command, dangerous, ask);
      if (need === null) execute(command).then(resolve);
      else setPending({ command, ask: need.kind === 'ask' ? need.ask : null, resolve });
    });
  }

  async function confirmed() {
    const current = pending;
    const sent = await execute(current.command);
    setPending(null);
    current.resolve(sent);
  }

  function cancelled() {
    pending.resolve(false);
    setPending(null);
  }

  let confirmDialog = null;
  if (pending?.ask) {
    const { ask } = pending;
    confirmDialog = html`<${Confirm}
      title=${ask.title}
      message=${ask.message}
      confirmLabel=${ask.label}
      danger=${Boolean(ask.danger)}
      busy=${busy}
      onConfirm=${confirmed}
      onCancel=${cancelled}
    />`;
  } else if (pending) {
    confirmDialog = html`<${Confirm}
      title=${t('console.confirm.title')}
      message=${html`<p class="confirm-message">${t('console.confirm.message')}</p>
        <code class="confirm-cmd">${pending.command}</code>
        <p class="hint">${t('console.confirm.hint')}</p>`}
      confirmLabel=${t('console.confirm.run')}
      danger
      busy=${busy}
      onConfirm=${confirmed}
      onCancel=${cancelled}
    />`;
  }

  return { send, busy, confirmDialog, lastReply };
}
