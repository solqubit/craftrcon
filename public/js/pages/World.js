// World: time, weather, difficulty, gamerules, world border and saving of the
// active server, plus the announcement editor.
//
// Every control sends one command through useCommandRunner (POST /command with
// origin 'ui', the reply as a toast, confirmation for commands on the
// "dangerous" list, which includes `difficulty`). The command builders are in
// lib/world.js. Gamerules are read from GET /gamerules only when their section
// is first opened (the server answers one rule at a time, so it can take a
// while); a change shows at once and the rule is re-read only if it failed.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { errorKey, isErrorOutput } from '../lib/console.js';
import {
  DIFFICULTIES, TIME_PRESETS, WEATHERS,
  difficulty, gamerule, saveAll, timeSet, weather, worldBorderCenter, worldBorderSet,
} from '../lib/world.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { Broadcast } from '../components/Broadcast.js';
import { useCommandRunner } from '../components/CommandRunner.js';
import { Icon } from '../components/Icon.js';

// A card with a title and, optionally, a hint under it.
function Section({ id, title, hint, children }) {
  return html`<section class="card wd-card" aria-labelledby=${`wd-${id}-title`}>
    <h2 id=${`wd-${id}-title`} class="card-title">${title}</h2>
    ${hint && html`<p class="hint">${hint}</p>`}
    ${children}
  </section>`;
}

// Runs a builder, shows its error code under the form and sends the command.
// Returns { error, run, clear }: `run(build)` is for a submit handler.
function useBuilt(send) {
  const [error, setError] = useState(null);
  async function run(build) {
    let command;
    try {
      command = build();
    } catch (err) {
      setError(err.message);
      return false;
    }
    setError(null);
    return send(command);
  }
  return { error, run, clear: () => setError(null) };
}

function FieldError({ id, code }) {
  return code ? html`<p id=${id} class="field-error" role="alert">${t(`world.errors.${code}`)}</p>` : null;
}

function TimeCard({ send, busy }) {
  const [value, setValue] = useState('');
  const { error, run, clear } = useBuilt(send);
  return html`<${Section} id="time" title=${t('world.time.title')} hint=${t('world.time.hint')}>
    <div class="wd-buttons">
      ${Object.entries(TIME_PRESETS).map(
        ([name, ticks]) => html`<button key=${name} type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => run(() => timeSet(ticks))}>
          ${t(`world.time.${name}`)}<span class="wd-ticks">${ticks}</span>
        </button>`,
      )}
    </div>
    <form
      class="wd-form"
      noValidate
      onSubmit=${(event) => {
        event.preventDefault();
        run(() => timeSet(value));
      }}
    >
      <div class="field wd-field">
        <label class="label" for="wd-time-exact">${t('world.time.exact')}</label>
        <input
          id="wd-time-exact"
          class="input mono"
          type="text"
          inputmode="numeric"
          value=${value}
          placeholder="6000"
          onInput=${(e) => { setValue(e.currentTarget.value); clear(); }}
          aria-invalid=${error ? 'true' : undefined}
          aria-describedby=${error ? 'wd-time-error' : undefined}
          autocomplete="off"
        />
        <${FieldError} id="wd-time-error" code=${error} />
      </div>
      <button type="submit" class="btn btn-primary" disabled=${busy}>${t('world.time.set')}</button>
    </form>
  </${Section}>`;
}

function WeatherCard({ send, busy }) {
  return html`<${Section} id="weather" title=${t('world.weather.title')}>
    <div class="wd-buttons">
      ${WEATHERS.map(
        (kind) => html`<button key=${kind} type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => send(weather(kind))}>
          ${t(`world.weather.${kind}`)}
        </button>`,
      )}
    </div>
  </${Section}>`;
}

function DifficultyCard({ send, busy }) {
  return html`<${Section} id="difficulty" title=${t('world.difficulty.title')} hint=${t('world.difficulty.hint')}>
    <div class="wd-buttons">
      ${DIFFICULTIES.map(
        (level) => html`<button key=${level} type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => send(difficulty(level))}>
          ${t(`world.difficulty.${level}`)}
        </button>`,
      )}
    </div>
  </${Section}>`;
}

function BorderCard({ send, busy }) {
  const [size, setSize] = useState('');
  const [seconds, setSeconds] = useState('');
  const [x, setX] = useState('');
  const [z, setZ] = useState('');
  const sizeForm = useBuilt(send);
  const centerForm = useBuilt(send);

  const input = (id, label, value, set, form, props = {}) => html`<div class="field wd-field">
    <label class="label" for=${id}>${label}</label>
    <input
      id=${id}
      class="input mono"
      type="text"
      inputmode="decimal"
      value=${value}
      onInput=${(e) => { set(e.currentTarget.value); form.clear(); }}
      autocomplete="off"
      ...${props}
    />
  </div>`;

  return html`<${Section} id="border" title=${t('world.border.title')}>
    <form
      class="wd-form"
      noValidate
      onSubmit=${(event) => {
        event.preventDefault();
        sizeForm.run(() => worldBorderSet(size, seconds));
      }}
    >
      ${input('wd-border-size', t('world.border.size'), size, setSize, sizeForm, {
        placeholder: '1000',
        'aria-invalid': sizeForm.error === 'invalid_size' ? 'true' : undefined,
        'aria-describedby': sizeForm.error === 'invalid_size' ? 'wd-border-size-error' : undefined,
      })}
      ${input('wd-border-seconds', t('world.border.seconds'), seconds, setSeconds, sizeForm, {
        inputmode: 'numeric',
        placeholder: '0',
        'aria-invalid': sizeForm.error === 'invalid_seconds' ? 'true' : undefined,
        'aria-describedby': sizeForm.error === 'invalid_seconds' ? 'wd-border-size-error' : undefined,
      })}
      <button type="submit" class="btn btn-primary" disabled=${busy}>${t('world.border.setSize')}</button>
    </form>
    <p class="hint">${t('world.border.sizeHint')}</p>
    <${FieldError} id="wd-border-size-error" code=${sizeForm.error} />

    <h3 class="wd-sub">${t('world.border.centerTitle')}</h3>
    <form
      class="wd-form"
      noValidate
      onSubmit=${(event) => {
        event.preventDefault();
        centerForm.run(() => worldBorderCenter(x, z));
      }}
    >
      ${input('wd-border-x', t('world.border.x'), x, setX, centerForm, { placeholder: '0', 'aria-invalid': centerForm.error ? 'true' : undefined })}
      ${input('wd-border-z', t('world.border.z'), z, setZ, centerForm, { placeholder: '0', 'aria-invalid': centerForm.error ? 'true' : undefined })}
      <button type="submit" class="btn btn-primary" disabled=${busy}>${t('world.border.setCenter')}</button>
    </form>
    <${FieldError} id="wd-border-center-error" code=${centerForm.error} />
  </${Section}>`;
}

function SaveCard({ send, busy }) {
  return html`<${Section} id="save" title=${t('world.save.title')} hint=${t('world.save.hint')}>
    <div class="wd-buttons">
      <button type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => send(saveAll())}>${t('world.save.button')}</button>
    </div>
  </${Section}>`;
}

function BroadcastCard({ onOpen }) {
  return html`<${Section} id="broadcast" title=${t('broadcast.card.title')} hint=${t('broadcast.card.text')}>
    <div class="wd-buttons">
      <button type="button" class="btn btn-primary" onClick=${onOpen}>${t('broadcast.open')}</button>
    </div>
  </${Section}>`;
}

// ---------- Gamerules ----------

function BoolRule({ rule, busy, onChange }) {
  const on = rule.value === 'true';
  return html`<div class="wd-rule wd-rule-bool">
    <span class="wd-rule-name mono" id=${`wd-rule-${rule.name}`}>${rule.name}</span>
    <button
      type="button"
      role="switch"
      class="wd-switch"
      aria-checked=${on ? 'true' : 'false'}
      aria-labelledby=${`wd-rule-${rule.name}`}
      disabled=${busy}
      onClick=${() => onChange(rule.name, on ? 'false' : 'true')}
    ></button>
  </div>`;
}

function IntRule({ rule, draft, error, busy, onDraft, onSet }) {
  const shown = draft ?? rule.value;
  const inputId = `wd-rule-${rule.name}`;
  return html`<form
    class="wd-rule wd-rule-int"
    noValidate
    onSubmit=${(event) => {
      event.preventDefault();
      onSet(rule.name, shown);
    }}
  >
    <label class="wd-rule-name mono" for=${inputId}>${rule.name}</label>
    <input
      id=${inputId}
      class="input mono wd-rule-input"
      type="text"
      inputmode="numeric"
      value=${shown}
      onInput=${(e) => onDraft(rule.name, e.currentTarget.value)}
      aria-invalid=${error ? 'true' : undefined}
      aria-describedby=${error ? `${inputId}-error` : undefined}
      autocomplete="off"
    />
    <button type="submit" class="btn btn-secondary btn-sm" disabled=${busy} aria-label=${`${t('world.gamerules.set')} ${rule.name}`}>${t('world.gamerules.set')}</button>
    ${error && html`<p id=${`${inputId}-error`} class="field-error wd-rule-error" role="alert">${t(`world.errors.${error}`)}</p>`}
  </form>`;
}

function Gamerules({ serverId, send, busy, lastReply }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState(null); // null until loaded: [{ name, type, value }]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null); // code of a failed load
  const [drafts, setDrafts] = useState({}); // typed, not yet sent, numbers by rule name
  const [ruleErrors, setRuleErrors] = useState({}); // builder code by rule name
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api(`/api/servers/${serverId}/gamerules`);
      if (alive.current) setRules(Array.isArray(result) ? result : []);
    } catch (err) {
      if (alive.current && err.status !== 401) setError(err.status === 404 ? 'not_found' : err.code);
    }
    if (alive.current) setLoading(false);
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && rules === null && !loading) load();
  }

  const setValue = (name, value) =>
    setRules((list) => list?.map((rule) => (rule.name === name ? { ...rule, value } : rule)) ?? list);

  // Reads the rules again and keeps only the value of `name` (the rest of the
  // list may hold values the user is editing); if even that fails the shown
  // value goes back to `fallback`.
  async function reloadRule(name, fallback) {
    try {
      const fresh = (await api(`/api/servers/${serverId}/gamerules`)).find((rule) => rule.name === name);
      if (alive.current && fresh) setValue(name, fresh.value);
      else if (alive.current) setValue(name, fallback);
    } catch {
      if (alive.current) setValue(name, fallback);
    }
  }

  async function change(name, raw) {
    let command;
    try {
      command = gamerule(rules, name, raw);
    } catch (err) {
      setRuleErrors((errors) => ({ ...errors, [name]: err.message }));
      return;
    }
    setRuleErrors((errors) => ({ ...errors, [name]: null }));
    const previous = rules.find((rule) => rule.name === name).value;
    const value = command.slice(`gamerule ${name} `.length);
    setValue(name, value);
    const sent = await send(command);
    if (!alive.current) return;
    if (sent) setDrafts((d) => ({ ...d, [name]: undefined }));
    if (!sent || isErrorOutput(lastReply.current)) await reloadRule(name, previous);
  }

  const onDraft = (name, value) => {
    setDrafts((d) => ({ ...d, [name]: value }));
    setRuleErrors((errors) => ({ ...errors, [name]: null }));
  };

  let body = null;
  if (open) {
    if (loading) {
      body = html`<div class="wd-loading" role="status">
        <span class="spinner" aria-hidden="true"></span><span>${t('world.gamerules.loading')}</span>
      </div>`;
    } else if (error !== null) {
      body = html`<div class="alert alert-error" role="alert">
        <${Icon} name="error" size=${16} />
        <span>${t('world.gamerules.loadFailed')}: ${t(errorKey(error))}</span>
        <button type="button" class="btn btn-secondary btn-sm wd-alert-action" onClick=${load}>${t('common.retry')}</button>
      </div>`;
    } else if (rules !== null && rules.length === 0) {
      body = html`<p class="hint">${t('world.gamerules.empty')}</p>`;
    } else if (rules !== null) {
      const bools = rules.filter((rule) => rule.type === 'bool');
      const ints = rules.filter((rule) => rule.type !== 'bool');
      body = html`<div class="wd-rules">
        ${bools.length > 0 &&
        html`<div class="wd-rule-group" role="group" aria-label=${t('world.gamerules.booleans')}>
          ${bools.map((rule) => html`<${BoolRule} key=${rule.name} rule=${rule} busy=${busy} onChange=${change} />`)}
        </div>`}
        ${ints.length > 0 &&
        html`<div class="wd-rule-group" role="group" aria-label=${t('world.gamerules.numbers')}>
          ${ints.map(
            (rule) => html`<${IntRule}
              key=${rule.name}
              rule=${rule}
              draft=${drafts[rule.name]}
              error=${ruleErrors[rule.name]}
              busy=${busy}
              onDraft=${onDraft}
              onSet=${change}
            />`,
          )}
        </div>`}
      </div>`;
    }
  }

  return html`<section class="card wd-card wd-wide" aria-labelledby="wd-rules-title">
    <div class="card-head wd-rules-head">
      <div>
        <h2 id="wd-rules-title" class="card-title">${t('world.gamerules.title')}</h2>
        <p class="hint">${t('world.gamerules.hint')}</p>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" aria-expanded=${open ? 'true' : 'false'} aria-controls="wd-rules-body" onClick=${toggleOpen}>
        <${Icon} name="chevronDown" size=${14} class=${open ? 'wd-flip' : ''} />${open ? t('world.gamerules.hide') : t('world.gamerules.show')}
      </button>
    </div>
    <div id="wd-rules-body">${body}</div>
  </section>`;
}

// ---------- Page ----------

function WorldView({ server }) {
  const { send, busy, confirmDialog, lastReply } = useCommandRunner(server.id);
  const [broadcasting, setBroadcasting] = useState(false);

  return html`<div class="page wd">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.world')}</h1>
        <p class="page-subtitle">${t('world.subtitle', { name: server.name })}</p>
      </div>
    </header>
    <div class="wd-grid">
      <${TimeCard} send=${send} busy=${busy} />
      <${WeatherCard} send=${send} busy=${busy} />
      <${DifficultyCard} send=${send} busy=${busy} />
      <${SaveCard} send=${send} busy=${busy} />
      <${BorderCard} send=${send} busy=${busy} />
      <${BroadcastCard} onOpen=${() => setBroadcasting(true)} />
    </div>
    <${Gamerules} serverId=${server.id} send=${send} busy=${busy} lastReply=${lastReply} />
    ${broadcasting && html`<${Broadcast} server=${server} onClose=${() => setBroadcasting(false)} />`}
    ${confirmDialog}
  </div>`;
}

export function World() {
  return html`<${ActiveServer} titleKey="nav.world" view=${(server) => html`<${WorldView} key=${server.id} server=${server} />`} />`;
}
