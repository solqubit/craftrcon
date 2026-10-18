// Settings: password, language, the dangerous-commands list, the activity log
// and the version. Each section is a card that loads and fails on its own.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { LANGUAGES, getLang, t } from '../i18n.js';
import { useStore } from '../store.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { copyText } from '../lib/clipboard.js';
import { useCountdown } from '../lib/countdown.js';
import { publishDangerousCommands, refreshDangerousCommands, useDangerousCommands } from '../lib/dangerousCommands.js';
import {
  UPDATE_COMMAND,
  actionKey,
  addCommand,
  appendPage,
  checkPasswordForm,
  originKey,
  preview,
  retrySeconds,
  sameList,
} from '../lib/settings.js';
import { Confirm } from '../components/Confirm.js';
import { Empty } from '../components/Empty.js';
import { Icon } from '../components/Icon.js';
import { switchLanguage } from '../components/Layout.js';
import { toast } from '../components/Toast.js';

const ACTIVITY_PAGE = 50;
const EMPTY_PASSWORDS = { current: '', next: '', repeat: '' };

function Loading() {
  return html`<div class="page-loading" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span>${t('common.loading')}</span>
  </div>`;
}

function Section({ id, title, description, children }) {
  return html`<section class="card st-section" aria-labelledby=${`st-${id}`}>
    <header class="st-section-head">
      <h2 id=${`st-${id}`} class="st-section-title">${title}</h2>
      ${description && html`<p class="st-section-desc">${description}</p>`}
    </header>
    ${children}
  </section>`;
}

// ----- password -----

function PasswordField({ name, label, autocomplete, values, errors, onInput, disabled }) {
  const error = errors[name];
  const id = `st-pw-${name}`;
  return html`<div class="field">
    <label class="label" for=${id}>${label}</label>
    <input
      id=${id}
      class="input"
      type="password"
      name=${name}
      autocomplete=${autocomplete}
      value=${values[name]}
      onInput=${(e) => onInput(name, e.currentTarget.value)}
      disabled=${disabled}
      aria-invalid=${error ? 'true' : undefined}
      aria-describedby=${error ? `${id}-error` : undefined}
    />
    ${error && html`<p id=${`${id}-error`} class="field-error">${t(`settings.password.errors.${error}`)}</p>`}
  </div>`;
}

function PasswordSection() {
  const [values, setValues] = useState(EMPTY_PASSWORDS);
  const [errors, setErrors] = useState({}); // field -> error code
  const [failure, setFailure] = useState(null); // message of a failure that is not a field's
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const secondsLeft = useCountdown(lockedUntil);
  const locked = secondsLeft > 0;

  // When the lock runs out, its message has done its job.
  useEffect(() => {
    if (lockedUntil && !locked) setLockedUntil(0);
  }, [lockedUntil, locked]);

  const onInput = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  const focusField = (name) => document.getElementById(`st-pw-${name}`)?.focus();

  async function submit(event) {
    event.preventDefault();
    if (busy || locked) return;
    const found = checkPasswordForm(values);
    setErrors(found);
    setFailure(null);
    const first = ['current', 'next', 'repeat'].find((name) => found[name]);
    if (first) {
      focusField(first);
      return;
    }
    setBusy(true);
    try {
      await api('/api/settings/password', { method: 'POST', body: { current: values.current, next: values.next } });
      setValues(EMPTY_PASSWORDS);
      toast(t('settings.password.changed'));
    } catch (err) {
      if (err.status === 429) {
        setLockedUntil(Date.now() + retrySeconds(err.body?.retryAfterMs) * 1000);
      } else if (err.code === 'invalid_password') {
        setErrors({ current: 'invalid' });
        setValues((v) => ({ ...v, current: '' }));
        focusField('current');
      } else if (err.code === 'password_too_short') {
        setErrors({ next: 'too_short' });
        focusField('next');
      } else if (err.code === 'network_error') setFailure(t('errors.network'));
      else if (err.status !== 401) setFailure(t('settings.password.errors.failed'));
    }
    setBusy(false);
  }

  const message = locked ? t('settings.password.errors.tooMany', { seconds: secondsLeft }) : failure;
  const fieldProps = { values, errors, onInput, disabled: locked };
  return html`<${Section} id="password" title=${t('settings.password.title')} description=${t('settings.password.description')}>
    <form class="st-form" onSubmit=${submit} noValidate>
      <${PasswordField} name="current" label=${t('settings.password.current')} autocomplete="current-password" ...${fieldProps} />
      <${PasswordField} name="next" label=${t('settings.password.next')} autocomplete="new-password" ...${fieldProps} />
      <${PasswordField} name="repeat" label=${t('settings.password.repeat')} autocomplete="new-password" ...${fieldProps} />
      <p class="hint">${t('settings.password.hint')}</p>
      <div class=${`alert ${locked ? 'alert-warn' : 'alert-error'}`} role="alert" hidden=${!message}>
        <${Icon} name=${locked ? 'warn' : 'error'} size=${16} />
        <span>${message}</span>
      </div>
      <div class="st-actions">
        <button type="submit" class="btn btn-primary" disabled=${busy || locked} aria-busy=${busy ? 'true' : undefined}>
          ${busy && html`<span class="spinner" aria-hidden="true"></span>`}
          ${t(busy ? 'settings.password.submitting' : 'settings.password.submit')}
        </button>
      </div>
    </form>
  </${Section}>`;
}

// ----- language -----

function LanguageSection() {
  const lang = useStore().lang;
  const onChange = async (event) => {
    const select = event.currentTarget; // currentTarget is gone after the await
    if (!(await switchLanguage(select.value))) select.value = lang;
  };
  return html`<${Section} id="language" title=${t('settings.language.title')} description=${t('settings.language.description')}>
    <div class="field st-narrow">
      <label class="label" for="st-lang">${t('settings.language.label')}</label>
      <select id="st-lang" class="select" value=${lang} onChange=${onChange}>
        ${LANGUAGES.map((l) => html`<option value=${l.code} lang=${l.code}>${l.name}</option>`)}
      </select>
    </div>
  </${Section}>`;
}

// ----- dangerous commands -----

// The sentences for the API's `fields` of a rejected PUT (commands.N / commands).
function dangerousProblems(fields, draft) {
  return Object.entries(fields ?? {}).map(([key, code]) => {
    const reason = t(`settings.dangerous.errors.${code}`);
    const index = /^commands\.(\d+)$/.exec(key)?.[1];
    return index === undefined ? reason : t('settings.dangerous.errors.item', { command: draft[Number(index)] ?? '', reason });
  });
}

function DangerousSection() {
  const { commands, loaded, failed } = useDangerousCommands();
  const [draft, setDraft] = useState(null); // null until the saved list is known
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState(null);
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const field = useRef(null);

  // The draft starts as the saved list, once the API has really answered
  // (before that `commands` is only the defaults).
  useEffect(() => {
    if (loaded) setDraft((current) => current ?? commands);
  }, [loaded]);

  async function retry() {
    setRetrying(true);
    await refreshDangerousCommands();
    setRetrying(false);
  }

  async function put(list) {
    setBusy(true);
    setProblems([]);
    try {
      const saved = await api('/api/settings/dangerous-commands', { method: 'PUT', body: list });
      publishDangerousCommands(saved);
      setDraft(saved);
      setInputError(null);
      return true;
    } catch (err) {
      if (err.status === 400) setProblems(dangerousProblems(err.body?.fields, list));
      else if (err.status !== 401) setProblems([t(err.code === 'network_error' ? 'errors.network' : 'settings.dangerous.errors.failed')]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (await put(draft)) toast(t('settings.dangerous.saved'));
  }

  async function restore() {
    const ok = await put([...DEFAULT_DANGEROUS_COMMANDS]);
    setRestoring(false);
    if (ok) toast(t('settings.dangerous.restored'));
  }

  function add(event) {
    event.preventDefault();
    const result = addCommand(draft, input);
    if (result.error) {
      setInputError(result.error);
      field.current?.focus();
      return;
    }
    setDraft(result.list);
    setInput('');
    setInputError(null);
    setProblems([]);
  }

  const remove = (command) => {
    setDraft((list) => list.filter((c) => c !== command));
    setProblems([]);
  };

  let body;
  if (draft === null && failed) {
    body = html`<${Empty}
      icon="error"
      title=${t('settings.dangerous.loadFailed')}
      action=${html`<button type="button" class="btn btn-secondary" onClick=${retry} disabled=${retrying}>${t('common.retry')}</button>`}
    />`;
  } else if (draft === null) body = html`<${Loading} />`;
  else {
    const dirty = !sameList(draft, commands);
    body = html`
      ${draft.length === 0
        ? html`<p class="st-chips-empty">${t('settings.dangerous.empty')}</p>`
        : html`<ul class="st-chips" aria-label=${t('settings.dangerous.title')}>
            ${draft.map(
              (command) => html`<li key=${command} class="st-chip">
                <span class="mono">${command}</span>
                <button
                  type="button"
                  class="st-chip-remove"
                  aria-label=${t('settings.dangerous.remove', { command })}
                  title=${t('settings.dangerous.remove', { command })}
                  onClick=${() => remove(command)}
                  disabled=${busy}
                >
                  <${Icon} name="close" size=${13} />
                </button>
              </li>`,
            )}
          </ul>`}
      <form class="st-add" onSubmit=${add} noValidate>
        <div class="field">
          <label class="label" for="st-dangerous-add">${t('settings.dangerous.add')}</label>
          <div class="st-add-row">
            <input
              ref=${field}
              id="st-dangerous-add"
              class="input mono"
              type="text"
              value=${input}
              placeholder=${t('settings.dangerous.placeholder')}
              autocomplete="off"
              autocapitalize="off"
              spellcheck=${false}
              onInput=${(e) => {
                setInput(e.currentTarget.value);
                setInputError(null);
              }}
              disabled=${busy}
              aria-invalid=${inputError ? 'true' : undefined}
              aria-describedby=${inputError ? 'st-dangerous-add-error' : undefined}
            />
            <button type="submit" class="btn btn-secondary" disabled=${busy}>
              <${Icon} name="plus" size=${16} />${t('settings.dangerous.addButton')}
            </button>
          </div>
          ${inputError && html`<p id="st-dangerous-add-error" class="field-error">${t(`settings.dangerous.errors.${inputError}`)}</p>`}
        </div>
      </form>
      ${problems.length > 0 &&
      html`<div class="alert alert-error" role="alert">
        <${Icon} name="error" size=${16} />
        <ul class="st-problems">${problems.map((text) => html`<li>${text}</li>`)}</ul>
      </div>`}
      <div class="st-actions">
        <button type="button" class="btn btn-primary" onClick=${save} disabled=${busy || !dirty} aria-busy=${busy ? 'true' : undefined}>
          ${busy && html`<span class="spinner" aria-hidden="true"></span>`}
          ${t('common.save')}
        </button>
        <button type="button" class="btn btn-secondary" onClick=${() => setRestoring(true)} disabled=${busy}>
          ${t('settings.dangerous.restore')}
        </button>
        ${dirty && html`<span class="hint">${t('settings.dangerous.unsaved')}</span>`}
      </div>
      ${restoring &&
      html`<${Confirm}
        title=${t('settings.dangerous.restoreTitle')}
        message=${t('settings.dangerous.restoreMessage')}
        confirmLabel=${t('settings.dangerous.restore')}
        busy=${busy}
        onConfirm=${restore}
        onCancel=${() => setRestoring(false)}
      />`}
    `;
  }
  return html`<${Section} id="dangerous" title=${t('settings.dangerous.title')} description=${t('settings.dangerous.description')}>
    ${body}
  </${Section}>`;
}

// ----- activity -----

const dateTime = (ts) =>
  new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(ts));

function ActivityRow({ item }) {
  const origin = originKey(item.origin);
  const action = actionKey(item.action);
  const result = preview(item.result);
  return html`<tr class=${item.ok ? '' : 'st-row-failed'}>
    <td data-label=${t('settings.activity.columns.when')} class="st-when">
      <time datetime=${new Date(item.ts).toISOString()}>${dateTime(item.ts)}</time>
    </td>
    <td data-label=${t('settings.activity.columns.server')} class=${item.serverName ? '' : 'st-none'}>${item.serverName ?? '—'}</td>
    <td data-label=${t('settings.activity.columns.origin')}>
      <span class=${`pill pill-neutral st-origin st-origin-${item.origin}`}>${origin ? t(origin) : item.origin}</span>
    </td>
    <td data-label=${t('settings.activity.columns.action')}>${action ? t(action) : item.action}</td>
    <td data-label=${t('settings.activity.columns.detail')} class=${`st-detail ${item.detail ? '' : 'st-none'}`}>${item.detail ? html`<span class="mono">${item.detail}</span>` : '—'}</td>
    <td data-label=${t('settings.activity.columns.ok')} class="st-ok">
      <span class=${item.ok ? 'st-ok-yes' : 'st-ok-no'}>
        <${Icon} name=${item.ok ? 'check' : 'close'} size=${15} />
        <span class="sr-only">${t(item.ok ? 'settings.activity.ok' : 'settings.activity.failed')}</span>
      </span>
    </td>
    <td data-label=${t('settings.activity.columns.result')} class=${`st-result ${item.result ? '' : 'st-none'}`}>
      ${item.result
        ? result.cut
          ? html`<details>
              <summary><span class="mono">${result.text}</span></summary>
              <pre class="st-result-full">${item.result}</pre>
            </details>`
          : html`<span class="mono">${result.text}</span>`
        : '—'}
    </td>
  </tr>`;
}

function ActivitySection() {
  const servers = useStore().servers;
  const [serverId, setServerId] = useState(''); // '' = all servers
  const [items, setItems] = useState(null); // null until the first page
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(false); // the first page failed
  const [moreFailed, setMoreFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [round, setRound] = useState(0);
  const generation = useRef(0); // drops answers of a filter / refresh that is no longer current

  const query = (before) => {
    const params = new URLSearchParams({ limit: String(ACTIVITY_PAGE) });
    if (serverId !== '') params.set('serverId', serverId);
    if (before) params.set('before', String(before));
    return `/api/activity?${params}`;
  };

  useEffect(() => {
    const mine = ++generation.current;
    setItems(null);
    setError(false);
    setMoreFailed(false);
    setLoadingMore(false);
    api(query())
      .then((page) => {
        if (mine !== generation.current) return;
        setItems(page.items);
        setNextBefore(page.nextBefore);
      })
      .catch((err) => {
        if (mine === generation.current && err.status !== 401) setError(true);
      });
  }, [serverId, round]);

  async function loadMore() {
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await api(query(nextBefore));
      if (mine !== generation.current) return;
      setItems((list) => appendPage(list, page.items));
      setNextBefore(page.nextBefore);
    } catch (err) {
      if (mine === generation.current && err.status !== 401) setMoreFailed(true);
    }
    if (mine === generation.current) setLoadingMore(false);
  }

  let body;
  if (error) {
    body = html`<${Empty}
      icon="error"
      title=${t('settings.activity.loadFailed')}
      action=${html`<button type="button" class="btn btn-secondary" onClick=${() => setRound((n) => n + 1)}>${t('common.retry')}</button>`}
    />`;
  } else if (items === null) body = html`<${Loading} />`;
  else if (items.length === 0) {
    body = html`<${Empty} icon="history" title=${t('settings.activity.empty.title')} message=${t('settings.activity.empty.message')} />`;
  } else {
    body = html`
      <div class="st-table-wrap">
        <table class="st-table">
          <caption class="sr-only">${t('settings.activity.title')}</caption>
          <thead>
            <tr>
              ${['when', 'server', 'origin', 'action', 'detail', 'ok', 'result'].map(
                (col) => html`<th scope="col">${t(`settings.activity.columns.${col}`)}</th>`,
              )}
            </tr>
          </thead>
          <tbody>${items.map((item) => html`<${ActivityRow} key=${item.id} item=${item} />`)}</tbody>
        </table>
      </div>
      ${moreFailed &&
      html`<div class="alert alert-error" role="alert">
        <${Icon} name="error" size=${16} /><span>${t('settings.activity.loadMoreFailed')}</span>
      </div>`}
      ${nextBefore !== null &&
      html`<div class="st-actions st-actions-center">
        <button type="button" class="btn btn-secondary" onClick=${loadMore} disabled=${loadingMore} aria-busy=${loadingMore ? 'true' : undefined}>
          ${loadingMore && html`<span class="spinner" aria-hidden="true"></span>`}
          ${t('settings.activity.loadMore')}
        </button>
      </div>`}
    `;
  }

  return html`<${Section} id="activity" title=${t('settings.activity.title')} description=${t('settings.activity.description')}>
    <div class="st-toolbar">
      <div class="field st-filter">
        <label class="label" for="st-activity-server">${t('settings.activity.filter')}</label>
        <select id="st-activity-server" class="select" value=${serverId} onChange=${(e) => setServerId(e.currentTarget.value)}>
          <option value="">${t('settings.activity.allServers')}</option>
          ${(servers ?? []).map((s) => html`<option value=${String(s.id)}>${s.name}</option>`)}
        </select>
      </div>
      <button type="button" class="btn btn-secondary" onClick=${() => setRound((n) => n + 1)} disabled=${items === null && !error}>
        ${t('settings.activity.refresh')}
      </button>
    </div>
    ${body}
  </${Section}>`;
}

// ----- about -----

function AboutSection() {
  const [info, setInfo] = useState(null); // null while loading, 'error', or the /api/version answer
  useEffect(() => {
    let current = true;
    api('/api/version')
      .then((result) => current && setInfo(result))
      .catch((err) => current && err.status !== 401 && setInfo('error'));
    return () => {
      current = false;
    };
  }, []);

  async function copy() {
    if (await copyText(UPDATE_COMMAND)) toast(t('settings.about.copied'));
    else toast(t('settings.about.copyFailed'), { type: 'error' });
  }

  let status = null;
  if (info === null) status = html`<span class="hint">${t('common.loading')}</span>`;
  else if (info === 'error' || info.latest === null || info.latest === undefined) {
    status = html`<p class="hint">${t('settings.about.checkFailed')}</p>`;
  } else if (!info.updateAvailable) {
    status = html`<p class="st-uptodate"><${Icon} name="success" size=${16} />${t('settings.about.upToDate')}</p>`;
  } else {
    status = html`<div class="alert alert-success st-update" role="status">
      <${Icon} name="info" size=${16} />
      <div class="st-update-body">
        <p><strong>${t('settings.about.updateAvailable', { latest: info.latest })}</strong></p>
        <p>${t('settings.about.updateHint')}</p>
        <div class="st-command">
          <code class="mono">${UPDATE_COMMAND}</code>
          <button type="button" class="btn btn-secondary btn-sm" onClick=${copy}>${t('settings.about.copy')}</button>
        </div>
      </div>
    </div>`;
  }

  const installed = info !== null && info !== 'error' && info.installed ? `v${String(info.installed).replace(/^v/, '')}` : '—';
  return html`<${Section} id="about" title=${t('settings.about.title')}>
    <dl class="st-about">
      <dt>${t('settings.about.installed')}</dt>
      <dd class="mono">${installed}</dd>
    </dl>
    ${status}
  </${Section}>`;
}

export function Settings() {
  return html`<div class="page st">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.settings')}</h1>
        <p class="page-subtitle">${t('settings.subtitle')}</p>
      </div>
    </header>
    <${PasswordSection} />
    <${LanguageSection} />
    <${DangerousSection} />
    <${ActivitySection} />
    <${AboutSection} />
  </div>`;
}
