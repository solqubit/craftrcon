// Moderation: bans, IP bans, the whitelist and operators of the active server,
// in four tabs. The selected tab lives in the URL hash query
// ("#/moderation?tab=ips"), so a reload or a shared link keeps it.
//
// Lists come from GET /bans?type=players|ips and GET /whitelist and are
// refetched after every change. Changes run through POST /command with origin
// 'ui' (audit log, not console history); the server's reply comes back as a
// toast. A command on the configurable "dangerous" list asks for confirmation
// first, and removing an entry (unban, whitelist remove) always does. When the
// server answers with text the panel can't parse ({ raw }), the text is shown
// as is and the forms stay available.
import { html, useEffect, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { ban, banIp, deop, op, pardon, pardonIp, whitelistAdd, whitelistRemove, whitelistToggle } from '../lib/builders.js';
import { errorKey } from '../lib/console.js';
import { isDangerous } from '../lib/dangerous.js';
import { MODERATION_TABS, filterBans, filterNames, listView, tabForKey, tabFromHash, tabHash } from '../lib/moderation.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { Confirm } from '../components/Confirm.js';
import { Empty } from '../components/Empty.js';
import { Head } from '../components/Head.js';
import { Icon } from '../components/Icon.js';
import { McText } from '../components/McText.js';
import { toast } from '../components/Toast.js';

const MAX_REASON = 256; // well inside RCON's limit

function Loading() {
  return html`<div class="page-loading" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span>${t('common.loading')}</span>
  </div>`;
}

// The command a builder makes, or null when the value can't be sent (the
// button of that row is then disabled).
function tryBuild(build) {
  try {
    return build();
  } catch {
    return null;
  }
}

// Loads `path` and reloads on demand. `data` keeps the last good answer while
// a later load fails, so the list stays on screen with a warning.
function useList(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    api(path)
      .then((result) => {
        if (!current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (current && err.status !== 401) setError(err.status === 404 ? 'not_found' : err.code);
      });
    return () => {
      current = false;
    };
  }, [path, round]);

  const reload = () => setRound((n) => n + 1);
  const retry = () => {
    setError(null);
    reload();
  };
  return { data, error, reload, retry };
}

// Shown when a list can't be loaded at all.
function LoadFailed({ error, onRetry }) {
  return html`<${Empty}
    icon="error"
    title=${t('moderation.loadFailed.title')}
    message=${t(errorKey(error))}
    action=${html`<button type="button" class="btn btn-secondary" onClick=${onRetry}>${t('common.retry')}</button>`}
  />`;
}

function RawAnswer({ text }) {
  return html`<section class="card" aria-labelledby="mod-raw-title">
    <h2 id="mod-raw-title" class="card-title">${t('moderation.raw.title')}</h2>
    <p class="hint">${t('moderation.raw.hint')}</p>
    <p class="dash-raw mono"><${McText} text=${text} /></p>
  </section>`;
}

function RefreshWarning({ error }) {
  return html`<div class="alert alert-warn" role="alert">
    <${Icon} name="warn" size=${16} />
    <span>${t('moderation.refreshFailed', { reason: t(errorKey(error)) })}</span>
  </div>`;
}

// The input that narrows a long list, with how many entries remain.
function Filter({ id, label, value, onChange, shown, total }) {
  return html`<div class="mod-filter">
    <label class="sr-only" for=${id}>${label}</label>
    <input
      id=${id}
      class="input"
      type="search"
      value=${value}
      placeholder=${label}
      onInput=${(e) => onChange(e.currentTarget.value)}
      autocomplete="off"
      autocapitalize="off"
      spellcheck=${false}
    />
    <span class="hint mod-filter-count" role="status">${t('moderation.filter.count', { shown, total })}</span>
  </div>`;
}

// A card with a one-line form: a name (or address), an optional reason and the
// submit button. `build(name, reason)` returns the command or throws a builder
// code. `extra` adds a second button that runs the same way: { label, build }.
function AddForm({ id, title, hint, nameLabel, namePlaceholder, nameHint, withReason = false, submit, extra, send }) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null); // builder code
  const [pending, setPending] = useState(false);

  async function run(build) {
    if (pending) return;
    let command;
    try {
      command = build(name.trim(), reason);
    } catch (err) {
      setError(err.message);
      document.getElementById(`${id}-name`)?.focus();
      return;
    }
    setPending(true);
    const sent = await send(command);
    setPending(false);
    if (sent) {
      setName('');
      setReason('');
    }
  }

  const describedBy = error ? `${id}-error` : nameHint ? `${id}-hint` : undefined;
  return html`<section class="card mod-card" aria-labelledby=${`${id}-title`}>
    <h2 id=${`${id}-title`} class="card-title">${title}</h2>
    ${hint && html`<p class="hint">${hint}</p>`}
    <form
      class="mod-form"
      onSubmit=${(event) => {
        event.preventDefault();
        run(submit.build);
      }}
      noValidate
    >
      <div class="field mod-field">
        <label class="label" for=${`${id}-name`}>${nameLabel}</label>
        <input
          id=${`${id}-name`}
          class="input mono"
          type="text"
          value=${name}
          placeholder=${namePlaceholder}
          onInput=${(e) => {
            setName(e.currentTarget.value);
            setError(null);
          }}
          disabled=${pending}
          aria-invalid=${error ? 'true' : undefined}
          aria-describedby=${describedBy}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck=${false}
        />
        ${error
          ? html`<p id=${`${id}-error`} class="field-error" role="alert">${t(`moderation.errors.${error}`)}</p>`
          : nameHint && html`<p id=${`${id}-hint`} class="hint">${nameHint}</p>`}
      </div>
      ${withReason &&
      html`<div class="field mod-field">
        <label class="label" for=${`${id}-reason`}>${t('moderation.reason')}</label>
        <input
          id=${`${id}-reason`}
          class="input"
          type="text"
          value=${reason}
          maxlength=${MAX_REASON}
          placeholder=${t('moderation.reasonPlaceholder')}
          onInput=${(e) => setReason(e.currentTarget.value)}
          disabled=${pending}
          autocomplete="off"
        />
      </div>`}
      <div class="mod-form-actions">
        <button type="submit" class=${`btn ${submit.danger ? 'btn-danger' : 'btn-primary'}`} disabled=${pending} aria-busy=${pending ? 'true' : undefined}>
          ${pending && html`<span class="spinner" aria-hidden="true"></span>`}${submit.label}
        </button>
        ${extra &&
        html`<button type="button" class="btn btn-secondary" onClick=${() => run(extra.build)} disabled=${pending}>${extra.label}</button>`}
      </div>
    </form>
  </section>`;
}

// Bans (type 'players') and IP bans (type 'ips'): the same table over a
// different list; IP bans have no head to show.
function BansTab({ server, type, send }) {
  const ips = type === 'ips';
  const ns = ips ? 'moderation.ips' : 'moderation.bans';
  const { data, error, reload, retry } = useList(`/api/servers/${server.id}/bans?type=${type}`);
  const [query, setQuery] = useState('');

  async function mutate(command, ask) {
    const sent = await send(command, ask);
    if (sent) reload();
    return sent;
  }

  const form = ips
    ? html`<${AddForm}
        id="mod-ban-ip"
        title=${t('moderation.ips.addTitle')}
        nameLabel=${t('moderation.ips.target')}
        namePlaceholder="203.0.113.7"
        nameHint=${t('moderation.ips.targetHint')}
        withReason
        submit=${{ label: t('moderation.ips.submit'), danger: true, build: (target, reason) => banIp(target, reason) }}
        send=${mutate}
      />`
    : html`<${AddForm}
        id="mod-ban"
        title=${t('moderation.bans.addTitle')}
        nameLabel=${t('moderation.player')}
        namePlaceholder="Steve"
        withReason
        submit=${{ label: t('moderation.bans.submit'), danger: true, build: (name, reason) => ban(name, reason) }}
        send=${mutate}
      />`;

  const view = data === null ? null : listView(data, 'entries');
  let body;
  if (data === null && error === null) body = html`<${Loading} />`;
  else if (data === null) body = html`<${LoadFailed} error=${error} onRetry=${retry} />`;
  else if (view.kind === 'raw') body = html`<${RawAnswer} text=${view.raw} />`;
  else if (view.kind === 'unknown') body = html`<${LoadFailed} error="failed" onRetry=${retry} />`;
  else if (view.items.length === 0) {
    body = html`<${Empty} icon="moderation" title=${t(`${ns}.empty.title`)} message=${t(`${ns}.empty.message`, { name: server.name })} />`;
  } else {
    const entries = filterBans(view.items, query);
    body = html`<section class="card mod-card" aria-labelledby="mod-list-title">
      <h2 id="mod-list-title" class="card-title">${t(`${ns}.listTitle`)}</h2>
      <${Filter}
        id="mod-filter"
        label=${t(`${ns}.filter`)}
        value=${query}
        onChange=${setQuery}
        shown=${entries.length}
        total=${view.items.length}
      />
      ${entries.length === 0
        ? html`<p class="mod-nomatch">${t('moderation.filter.none', { query: query.trim() })}</p>`
        : html`<div class="mod-table-wrap">
            <table class="mod-table">
              <thead>
                <tr>
                  <th scope="col">${ips ? t('moderation.address') : t('moderation.player')}</th>
                  <th scope="col">${t('moderation.source')}</th>
                  <th scope="col">${t('moderation.reasonColumn')}</th>
                  <th scope="col"><span class="sr-only">${t('moderation.actions.label')}</span></th>
                </tr>
              </thead>
              <tbody>
                ${entries.map((entry, i) => {
                  const command = tryBuild(() => (ips ? pardonIp(entry.target) : pardon(entry.target)));
                  return html`<tr key=${`${i}:${entry.target}`}>
                    <td class="mod-who" data-label=${ips ? t('moderation.address') : t('moderation.player')}>
                      ${!ips && html`<${Head} name=${entry.target} size=${24} />`}
                      <span class=${ips ? 'mono' : undefined}>${entry.target}</span>
                    </td>
                    <td data-label=${t('moderation.source')}>${entry.source}</td>
                    <td class="mod-reason" data-label=${t('moderation.reasonColumn')}>
                      ${entry.reason === '' ? html`<span class="mod-none">${t('moderation.noReason')}</span>` : entry.reason}
                    </td>
                    <td class="mod-act">
                      <button
                        type="button"
                        class="btn btn-secondary btn-sm"
                        disabled=${command === null}
                        aria-label=${t('moderation.actions.unbanName', { name: entry.target })}
                        onClick=${() =>
                          mutate(command, {
                            title: t('moderation.confirm.unbanTitle', { name: entry.target }),
                            message: t('moderation.confirm.unban', { name: entry.target }),
                            label: t('moderation.actions.unban'),
                          })}
                      >
                        ${t('moderation.actions.unban')}
                      </button>
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>`}
    </section>`;
  }

  return html`<div class="mod-stack">
    ${form}
    ${error !== null && data !== null && html`<${RefreshWarning} error=${error} />`}
    ${body}
  </div>`;
}

function WhitelistTab({ server, send }) {
  const { data, error, reload, retry } = useList(`/api/servers/${server.id}/whitelist`);
  const [query, setQuery] = useState('');
  const [toggling, setToggling] = useState(false);

  async function mutate(command, ask) {
    const sent = await send(command, ask);
    if (sent) reload();
    return sent;
  }

  async function toggle(on) {
    setToggling(true);
    await send(whitelistToggle(on));
    setToggling(false);
  }

  const view = data === null ? null : listView(data, 'players');
  let body;
  if (data === null && error === null) body = html`<${Loading} />`;
  else if (data === null) body = html`<${LoadFailed} error=${error} onRetry=${retry} />`;
  else if (view.kind === 'raw') body = html`<${RawAnswer} text=${view.raw} />`;
  else if (view.kind === 'unknown') body = html`<${LoadFailed} error="failed" onRetry=${retry} />`;
  else if (view.items.length === 0) {
    body = html`<${Empty} icon="moderation" title=${t('moderation.whitelist.empty.title')} message=${t('moderation.whitelist.empty.message', { name: server.name })} />`;
  } else {
    const names = filterNames(view.items, query);
    body = html`<section class="card mod-card" aria-labelledby="mod-list-title">
      <h2 id="mod-list-title" class="card-title">${t('moderation.whitelist.listTitle')}</h2>
      <${Filter}
        id="mod-filter"
        label=${t('moderation.whitelist.filter')}
        value=${query}
        onChange=${setQuery}
        shown=${names.length}
        total=${view.items.length}
      />
      ${names.length === 0
        ? html`<p class="mod-nomatch">${t('moderation.filter.none', { query: query.trim() })}</p>`
        : html`<ul class="pl-list mod-names">
            ${names.map((name) => {
              const command = tryBuild(() => whitelistRemove(name));
              return html`<li key=${name} class="pl-row">
                <${Head} name=${name} size=${28} />
                <span class="pl-name">${name}</span>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  disabled=${command === null}
                  aria-label=${t('moderation.actions.removeName', { name })}
                  onClick=${() =>
                    mutate(command, {
                      title: t('moderation.confirm.removeTitle', { name }),
                      message: t('moderation.confirm.remove', { name }),
                      label: t('moderation.actions.remove'),
                      danger: true,
                    })}
                >
                  ${t('moderation.actions.remove')}
                </button>
              </li>`;
            })}
          </ul>`}
    </section>`;
  }

  return html`<div class="mod-stack">
    <section class="card mod-card" aria-labelledby="mod-toggle-title">
      <h2 id="mod-toggle-title" class="card-title">${t('moderation.whitelist.toggleTitle')}</h2>
      <p class="hint">${t('moderation.whitelist.toggleHint')}</p>
      <div class="mod-form-actions">
        <button type="button" class="btn btn-secondary" disabled=${toggling} onClick=${() => toggle(true)}>${t('moderation.whitelist.on')}</button>
        <button type="button" class="btn btn-danger" disabled=${toggling} onClick=${() => toggle(false)}>${t('moderation.whitelist.off')}</button>
      </div>
    </section>
    <${AddForm}
      id="mod-wl"
      title=${t('moderation.whitelist.addTitle')}
      nameLabel=${t('moderation.player')}
      namePlaceholder="Steve"
      submit=${{ label: t('moderation.whitelist.submit'), build: (name) => whitelistAdd(name) }}
      send=${mutate}
    />
    ${error !== null && data !== null && html`<${RefreshWarning} error=${error} />`}
    ${body}
  </div>`;
}

// RCON can't list operators, so this tab has no list: only the form.
function OpsTab({ send }) {
  return html`<div class="mod-stack">
    <${AddForm}
      id="mod-op"
      title=${t('moderation.ops.title')}
      hint=${t('moderation.ops.hint')}
      nameLabel=${t('moderation.player')}
      namePlaceholder="Steve"
      submit=${{ label: t('moderation.ops.add'), build: (name) => op(name) }}
      extra=${{ label: t('moderation.ops.remove'), build: (name) => deop(name) }}
      send=${send}
    />
  </div>`;
}

function Tabs({ tab, onSelect }) {
  function onKeyDown(event) {
    const next = tabForKey(event.key, tab);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    document.getElementById(`mod-tab-${next}`)?.focus();
  }
  return html`<div class="mod-tabs" role="tablist" aria-label=${t('moderation.tabsLabel')} onKeyDown=${onKeyDown}>
    ${MODERATION_TABS.map((name) => {
      const selected = name === tab;
      return html`<button
        key=${name}
        type="button"
        role="tab"
        id=${`mod-tab-${name}`}
        class=${`mod-tab ${selected ? 'on' : ''}`}
        aria-selected=${selected ? 'true' : 'false'}
        aria-controls=${selected ? 'mod-panel' : undefined}
        tabindex=${selected ? 0 : -1}
        onClick=${() => onSelect(name)}
      >
        ${t(`moderation.tabs.${name}`)}
      </button>`;
    })}
  </div>`;
}

function ModerationView({ server }) {
  const id = server.id;
  const [tab, setTab] = useState(() => tabFromHash(location.hash));
  const [dangerous, setDangerous] = useState(DEFAULT_DANGEROUS_COMMANDS);
  const [confirm, setConfirm] = useState(null); // { command, ask, resolve }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/settings/dangerous-commands')
      .then((list) => Array.isArray(list) && setDangerous(list))
      .catch(() => {}); // keep the defaults: better one confirmation too many
  }, []);

  // Back/forward and the sidebar link change the hash without a remount.
  useEffect(() => {
    const onChange = () => setTab(tabFromHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  function select(next) {
    setTab(next);
    history.replaceState(null, '', tabHash(next)); // no history entry, no hashchange
  }

  // Sends the command; true when the server took it.
  async function execute(command) {
    setBusy(true);
    let sent = false;
    try {
      const result = await api(`/api/servers/${id}/command`, { method: 'POST', body: { command, origin: 'ui' } });
      if (result.ok) {
        sent = true;
        const reply = typeof result.output === 'string' ? result.output.trim() : '';
        if (reply) toast(html`<${McText} text=${reply} />`, { type: 'info' });
        else toast(t('moderation.toast.sent'));
      } else {
        toast(t(errorKey(result.error)), { type: 'error' });
      }
    } catch (err) {
      if (err.status !== 401) toast(t(errorKey(err.status === 404 ? 'not_found' : err.code)), { type: 'error' });
    }
    setBusy(false);
    return sent;
  }

  // Resolves true once the command went through, false when it failed or the
  // user said no. A command on the dangerous list asks first; `ask` ({ title,
  // message, label, danger }) makes any other command ask too.
  function send(command, ask) {
    return new Promise((resolve) => {
      if (isDangerous(command, dangerous) || ask) setConfirm({ command, ask: isDangerous(command, dangerous) ? null : ask, resolve });
      else execute(command).then(resolve);
    });
  }

  async function confirmed() {
    const pending = confirm;
    const sent = await execute(pending.command);
    setConfirm(null);
    pending.resolve(sent);
  }

  function cancelled() {
    confirm.resolve(false);
    setConfirm(null);
  }

  let panel;
  if (tab === 'bans') panel = html`<${BansTab} key="bans" server=${server} type="players" send=${send} />`;
  else if (tab === 'ips') panel = html`<${BansTab} key="ips" server=${server} type="ips" send=${send} />`;
  else if (tab === 'whitelist') panel = html`<${WhitelistTab} key="whitelist" server=${server} send=${send} />`;
  else panel = html`<${OpsTab} key="ops" send=${send} />`;

  const ask = confirm?.ask;
  return html`<div class="page mod">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.moderation')}</h1>
        <p class="page-subtitle">${t('moderation.subtitle', { name: server.name })}</p>
      </div>
    </header>
    <${Tabs} tab=${tab} onSelect=${select} />
    <div role="tabpanel" id="mod-panel" aria-labelledby=${`mod-tab-${tab}`}>${panel}</div>
    ${confirm &&
    (ask
      ? html`<${Confirm}
          title=${ask.title}
          message=${ask.message}
          confirmLabel=${ask.label}
          danger=${Boolean(ask.danger)}
          busy=${busy}
          onConfirm=${confirmed}
          onCancel=${cancelled}
        />`
      : html`<${Confirm}
          title=${t('console.confirm.title')}
          message=${html`<p class="confirm-message">${t('console.confirm.message')}</p>
            <code class="cl-confirm-cmd">${confirm.command}</code>
            <p class="hint">${t('console.confirm.hint')}</p>`}
          confirmLabel=${t('console.confirm.run')}
          danger
          busy=${busy}
          onConfirm=${confirmed}
          onCancel=${cancelled}
        />`)}
  </div>`;
}

export function Moderation() {
  return html`<${ActiveServer} titleKey="nav.moderation" view=${(server) => html`<${ModerationView} key=${server.id} server=${server} />`} />`;
}
