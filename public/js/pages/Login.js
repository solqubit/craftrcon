// Sign-in screen: one password field. Wrong passwords get a clear error; after
// too many attempts the panel answers 429 with retryAfterMs and the form counts
// down until it may be tried again.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { store } from '../store.js';
import { Brand, LangSelect } from '../components/Layout.js';
import { Icon } from '../components/Icon.js';

const RESET_COMMAND = 'sudo ./install.sh --reset-password';
const MARK = '\u0000';
// Renders a translated sentence with `code` set in monospace where MARK was interpolated.
const withCode = (text, code) => {
  const [before, after = ''] = text.split(MARK);
  return html`${before}<code class="mono">${code}</code>${after}`;
};

const errorText = (code) =>
  ({
    invalid_password: t('login.invalid'),
    empty: t('login.empty'),
    network_error: t('errors.network'),
  })[code] ?? t('login.failed');

// Seconds left until `until` (ms timestamp), re-rendering every 250 ms while > 0.
function useCountdown(until) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function Login() {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // error code, or null
  const [lockedUntil, setLockedUntil] = useState(0);
  const input = useRef(null);
  const secondsLeft = useCountdown(lockedUntil);
  const locked = secondsLeft > 0;

  useEffect(() => input.current?.focus(), []);

  // When the lock runs out, the countdown message has done its job.
  useEffect(() => {
    if (lockedUntil && !locked) {
      setLockedUntil(0);
      setError(null);
      input.current?.focus();
    }
  }, [lockedUntil, locked]);

  async function submit(event) {
    event.preventDefault();
    if (busy || locked) return;
    if (password === '') {
      setError('empty');
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/login', { method: 'POST', body: { password } });
      store.set({ authenticated: true });
    } catch (err) {
      setBusy(false);
      if (err.status === 429) {
        setLockedUntil(Date.now() + Math.max(1000, Number(err.body?.retryAfterMs) || 0));
        setError('too_many_attempts');
      } else {
        setError(err.code);
        if (err.code === 'invalid_password') setPassword('');
        input.current?.focus();
      }
    }
  }

  const message = locked ? t('login.tooMany', { seconds: secondsLeft }) : error && errorText(error);
  const invalid = error === 'invalid_password' || error === 'empty';

  return html`<div class="login">
    <div class="login-lang"><${LangSelect} /></div>
    <main class="login-main">
      <div class="login-brand"><${Brand} /></div>
      <form class="card login-card" onSubmit=${submit} noValidate>
        <div class="login-head">
          <span class="login-icon" aria-hidden="true"><${Icon} name="lock" size=${20} /></span>
          <h1 class="login-title">${t('login.title')}</h1>
          <p class="login-subtitle">${t('login.subtitle')}</p>
        </div>

        <div class="field">
          <label class="label" for="login-password">${t('login.password')}</label>
          <div class="input-group">
            <input
              ref=${input}
              id="login-password"
              class="input"
              type=${visible ? 'text' : 'password'}
              name="password"
              autocomplete="current-password"
              autocapitalize="off"
              spellcheck=${false}
              value=${password}
              onInput=${(e) => setPassword(e.currentTarget.value)}
              disabled=${locked}
              aria-invalid=${invalid ? 'true' : undefined}
              aria-describedby=${message ? 'login-error' : undefined}
            />
            <button
              type="button"
              class="input-addon"
              aria-label=${t(visible ? 'login.hide' : 'login.show')}
              aria-pressed=${visible ? 'true' : 'false'}
              onClick=${() => setVisible(!visible)}
            >
              <${Icon} name=${visible ? 'eyeOff' : 'eye'} size=${16} />
            </button>
          </div>
        </div>

        <div id="login-error" class=${`alert ${locked ? 'alert-warn' : 'alert-error'}`} role="alert" hidden=${!message}>
          <${Icon} name=${locked ? 'warn' : 'error'} size=${16} />
          <span>${message}</span>
        </div>

        <button type="submit" class="btn btn-primary btn-block btn-lg" disabled=${busy || locked} aria-busy=${busy ? 'true' : undefined}>
          ${busy && html`<span class="spinner" aria-hidden="true"></span>`}
          ${busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
      <p class="login-foot">${withCode(t('login.hint', { command: MARK }), RESET_COMMAND)}</p>
    </main>
  </div>`;
}
