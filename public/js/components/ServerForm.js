// Add / edit server form in a modal. Edit mode starts with an empty password
// (empty = keep the saved one); the API never returns it. "Test connection"
// probes the host and port as typed, without saving anything.
import { html, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  COLORS,
  ICONS,
  MAX_HOST,
  MAX_NAME,
  MAX_PASSWORD,
  buildPayload,
  buildTestPayload,
  fieldErrorKey,
  initialValues,
  testResultKey,
  validate,
  validateForTest,
} from '../lib/servers.js';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';

const FORM_ID = 'server-form';
const FIELD_ORDER = ['name', 'host', 'rconPort', 'password', 'gamePort'];
const fieldId = (field) => `server-${field}`;

// Radio group drawn as a row of tiles: native radios keep the arrow-key and
// screen-reader behavior; the visible tile is the sibling of the hidden input.
function Choices({ name, label, options, value, onChange, render, disabled }) {
  return html`<div class="field" role="radiogroup" aria-label=${label}>
    <span class="label" aria-hidden="true">${label}</span>
    <div class="choices">
      ${options.map(
        (option) => html`<label class="choice" key=${option}>
          <input
            type="radio"
            name=${name}
            value=${option}
            checked=${value === option}
            disabled=${disabled}
            onChange=${() => onChange(option)}
          />
          ${render(option)}
        </label>`,
      )}
    </div>
  </div>`;
}

export function ServerForm({ server = null, onClose, onSaved }) {
  const editing = server !== null;
  const [values, setValues] = useState(() => initialValues(server));
  const [errors, setErrors] = useState({}); // field -> API/client error code
  const [formError, setFormError] = useState(null); // translation key
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null); // null | 'running' | { ok, ... } | { failed: key }
  const testing = test === 'running';
  const busy = saving || testing;
  const latest = useRef(0); // test counter: an answer to an outdated test is ignored

  // Editing a field clears its error and any previous test result.
  const set = (field) => (event) => {
    const value = event.currentTarget.value;
    setValues((v) => ({ ...v, [field]: value }));
    setErrors(({ [field]: _gone, ...rest }) => rest);
    if (field === 'host' || field === 'rconPort' || field === 'password') {
      latest.current++;
      setTest(null);
    }
    setFormError(null);
  };
  const choose = (field) => (value) => setValues((v) => ({ ...v, [field]: value }));

  const fail = (found) => {
    setErrors(found);
    const first = FIELD_ORDER.find((f) => found[f]);
    if (first) document.getElementById(fieldId(first))?.focus();
  };

  // Maps an API error to field errors or a form-level message.
  function showApiError(err) {
    if (err.status === 400 && err.body?.fields) fail(err.body.fields);
    else if (err.status === 409 && err.code === 'name_taken') fail({ name: 'name_taken' });
    else if (err.status !== 401) setFormError(err.code === 'network_error' ? 'errors.network' : 'servers.errors.saveFailed');
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const found = validate(values, server);
    if (Object.keys(found).length > 0) return fail(found);
    setSaving(true);
    setFormError(null);
    try {
      const saved = await api(editing ? `/api/servers/${server.id}` : '/api/servers', {
        method: editing ? 'PUT' : 'POST',
        body: buildPayload(values),
      });
      onSaved(saved);
    } catch (err) {
      setSaving(false);
      showApiError(err);
    }
  }

  async function runTest() {
    if (busy) return;
    const found = validateForTest(values, server);
    if (Object.keys(found).length > 0) return fail(found);
    const run = ++latest.current;
    setTest('running');
    setFormError(null);
    let result;
    try {
      result = await api('/api/servers/test', { method: 'POST', body: buildTestPayload(values, server) });
    } catch (err) {
      if (run !== latest.current) return;
      setTest(null);
      if (err.status === 400 && err.body?.fields) fail(err.body.fields);
      else if (err.status !== 401) setTest({ failed: err.code === 'network_error' ? 'errors.network' : 'servers.test.failed' });
      return;
    }
    if (run === latest.current) setTest(result);
  }

  const errorText = (name) => {
    const code = errors[name];
    if (!code) return null;
    return code === 'name_taken' ? t('servers.errors.nameTaken') : t(fieldErrorKey(name, code, { editing }));
  };

  // A labelled field: `input(describedBy, invalid)` draws the control.
  const field = (name, label, input, hint) => {
    const message = errorText(name);
    const errorId = `${fieldId(name)}-error`;
    const hintId = `${fieldId(name)}-hint`;
    return html`<div class="field">
      <label class="label" for=${fieldId(name)}>${label}</label>
      ${input(message ? errorId : hint ? hintId : undefined, Boolean(message))}
      ${message && html`<p id=${errorId} class="field-error" role="alert">${message}</p>`}
      ${!message && hint && html`<p id=${hintId} class="hint">${hint}</p>`}
    </div>`;
  };

  const textInput = (name, { mono = false, ...attrs } = {}) => (describedBy, invalid) => html`<input
    id=${fieldId(name)}
    class=${`input ${mono ? 'mono' : ''}`.trim()}
    type="text"
    name=${name}
    value=${values[name]}
    onInput=${set(name)}
    disabled=${saving}
    aria-invalid=${invalid ? 'true' : undefined}
    aria-describedby=${describedBy}
    autocomplete="off"
    autocapitalize="off"
    spellcheck=${false}
    ...${attrs}
  />`;

  const passwordInput = (describedBy, invalid) => html`<div class="input-group">
    <input
      id=${fieldId('password')}
      class="input"
      type=${showPassword ? 'text' : 'password'}
      name="password"
      value=${values.password}
      onInput=${set('password')}
      disabled=${saving}
      maxlength=${MAX_PASSWORD}
      placeholder=${editing ? t('servers.passwordUnchanged') : undefined}
      aria-invalid=${invalid ? 'true' : undefined}
      aria-describedby=${describedBy}
      autocomplete="new-password"
      autocapitalize="off"
      spellcheck=${false}
    />
    <button
      type="button"
      class="input-addon"
      aria-label=${t(showPassword ? 'login.hide' : 'login.show')}
      aria-pressed=${showPassword ? 'true' : 'false'}
      onClick=${() => setShowPassword(!showPassword)}
    >
      <${Icon} name=${showPassword ? 'eyeOff' : 'eye'} size=${16} />
    </button>
  </div>`;

  const footer = html`
    <button type="button" class="btn btn-secondary form-test" onClick=${runTest} disabled=${busy} aria-busy=${testing ? 'true' : undefined}>
      ${testing ? html`<span class="spinner" aria-hidden="true"></span>` : html`<${Icon} name="bolt" size=${15} />`}
      ${testing ? t('servers.test.running') : t('servers.test.button')}
    </button>
    <button type="button" class="btn btn-secondary" onClick=${onClose} disabled=${saving}>${t('common.cancel')}</button>
    <button type="submit" form=${FORM_ID} class="btn btn-primary" disabled=${busy} aria-busy=${saving ? 'true' : undefined}>
      ${saving && html`<span class="spinner" aria-hidden="true"></span>`}
      ${t('common.save')}
    </button>
  `;

  const result = test !== null && test !== 'running' ? test : null;
  const resultOk = result?.ok === true;
  let resultText = '';
  if (result?.failed) resultText = t(result.failed);
  else if (resultOk) resultText = t('servers.test.ok', { ms: result.latencyMs });
  else if (result) resultText = t(testResultKey(result));

  const iconTile = (icon) => html`<span class="choice-face" title=${t(`servers.icons.${icon}`)}>
    <${Icon} name=${icon} size=${18} />
    <span class="sr-only">${t(`servers.icons.${icon}`)}</span>
  </span>`;
  const colorTile = (color) => html`<span class="choice-face choice-swatch" style=${{ '--srv': `var(--c-${color})` }} title=${t(`servers.colors.${color}`)}>
    <span class="sr-only">${t(`servers.colors.${color}`)}</span>
  </span>`;

  return html`<${Modal} title=${t(editing ? 'servers.editTitle' : 'servers.addTitle')} onClose=${onClose} busy=${saving} footer=${footer}>
    <form id=${FORM_ID} class="server-form" onSubmit=${submit} noValidate>
      ${field('name', t('servers.fields.name'), textInput('name', { maxlength: MAX_NAME, placeholder: t('servers.placeholders.name'), autofocus: true }))}
      <div class="form-row">
        ${field('host', t('servers.fields.host'), textInput('host', { mono: true, maxlength: MAX_HOST, placeholder: t('servers.placeholders.host') }))}
        ${field('rconPort', t('servers.fields.rconPort'), textInput('rconPort', { mono: true, inputmode: 'numeric', maxlength: 5 }))}
      </div>
      ${field('password', t('servers.fields.password'), passwordInput, t(editing ? 'servers.passwordHintEdit' : 'servers.passwordHint'))}
      ${field('gamePort', t('servers.fields.gamePort'), textInput('gamePort', { mono: true, inputmode: 'numeric', maxlength: 5 }), t('servers.gamePortHint'))}
      <${Choices} name="icon" label=${t('servers.fields.icon')} options=${ICONS} value=${values.icon} onChange=${choose('icon')} disabled=${saving} render=${iconTile} />
      <${Choices} name="color" label=${t('servers.fields.color')} options=${COLORS} value=${values.color} onChange=${choose('color')} disabled=${saving} render=${colorTile} />
      <div class=${`alert ${resultOk ? 'alert-success' : 'alert-error'}`} role="status" hidden=${!result}>
        <${Icon} name=${resultOk ? 'success' : 'error'} size=${16} />
        <span>${resultText}</span>
      </div>
      <div class="alert alert-error" role="alert" hidden=${!formError}>
        <${Icon} name="error" size=${16} />
        <span>${formError && t(formError)}</span>
      </div>
    </form>
  </${Modal}>`;
}
