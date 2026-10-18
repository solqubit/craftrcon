// Console: run commands on the active server, with autocompletion (Tab, ↑/↓),
// input history, favorites and confirmation for dangerous commands. Commands
// that tasks or other pages run on the same server stream in live.
//
// Our own commands come back twice (the POST's answer and the live echo); the
// log in lib/console.js shows each run once — see the note at its top.
// The screen of each server is kept in memory while the panel is open, so
// leaving the page and coming back does not lose it (the history, stored by
// the panel, survives reloads too).
import { Component, html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/htm-preact.js';
import { api, openLive } from '../api.js';
import { t } from '../i18n.js';
import { useStore } from '../store.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { applySuggestion, lastToken, signature, suggest } from '../lib/autocomplete.js';
import { isDangerous } from '../lib/dangerous.js';
import {
  addLive,
  addPending,
  commandProblem,
  errorKey,
  exportFilename,
  failSent,
  formatExport,
  matchesFilter,
  normalizeCommand,
  resolveSent,
  uniqueHistory,
  walkHistory,
} from '../lib/console.js';
import { getScreen, nextSendId, updateScreen } from '../lib/screens.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { Favorites, History } from '../components/ConsoleSide.js';
import { Confirm } from '../components/Confirm.js';
import { Entry } from '../components/ConsoleEntry.js';
import { FavoriteForm } from '../components/FavoriteForm.js';
import { Icon } from '../components/Icon.js';
import { toast } from '../components/Toast.js';

const PLAYERS_POLL_MS = 30_000;
const HISTORY_LIMIT = 200;
const EXAMPLES = ['list', 'help', 'seed'];
const LIST_ID = 'console-suggestions';

// ---------- Output ----------

// Up to 1000 lines: redraw only when the log (or the language) changes, not
// on every keystroke in the input.
class OutputLines extends Component {
  shouldComponentUpdate(next) {
    return next.entries !== this.props.entries || next.lang !== this.props.lang;
  }

  render({ entries }) {
    return entries.map((e) => html`<${Entry} key=${e.id != null ? `s${e.id}` : e.key} entry=${e} />`);
  }
}

// ---------- Prompt pieces ----------

// The label with the typed prefix highlighted ("gam" in "gamemode <mode> …").
function Highlighted({ label, token }) {
  const n = token && label.toLowerCase().startsWith(token.toLowerCase()) ? token.length : 0;
  return html`<span class="cl-option-label">${n > 0 && html`<b class="cl-match">${label.slice(0, n)}</b>`}${label.slice(n)}</span>`;
}

function Signature({ sig }) {
  return html`<div class="cl-signature" aria-hidden="true">
    <span class="cl-sig-syntax">
      <span class="cl-sig-name">${sig.name}</span>
      ${sig.args.map((arg, i) => html` <span class=${i === sig.active ? 'cl-sig-active' : undefined}>${arg}</span>`)}
    </span>
    <span class="cl-sig-desc">${t(sig.descKey)}</span>
  </div>`;
}

// ---------- Page ----------

// GET `path` as null (loading) | 'error' | transform(answer). A reload keeps
// the current list on screen; a retry after an error shows the spinner again.
function useList(path, transform = (x) => x) {
  const [state, setState] = useState(null);
  const load = async () => {
    setState((s) => (s === 'error' ? null : s));
    try {
      setState(transform(await api(path)));
    } catch (err) {
      if (err.status !== 401) setState('error');
    }
  };
  return [state, setState, load];
}

function ConsoleView({ server }) {
  const { lang } = useStore();
  const id = server.id;

  // Output log (source of truth: the module cache, so an answer that lands
  // after leaving the page is still there on return).
  const [entries, setEntries] = useState(() => getScreen(id));
  const update = (fn) => {
    const previous = getScreen(id);
    const next = updateScreen(id, fn);
    if (next !== previous) setEntries(next);
  };

  const [history, setHistory, loadHistory] = useList(`/api/servers/${id}/history`, uniqueHistory);
  const [favorites, , loadFavorites] = useList(`/api/servers/${id}/favorites`);
  const [players, setPlayers] = useState([]);
  const [dangerous, setDangerous] = useState(DEFAULT_DANGEROUS_COMMANDS);

  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false); // suggestions wanted: the user is typing
  const [active, setActive] = useState(0);
  const [walk, setWalk] = useState({ index: -1, draft: '' });
  const [inputError, setInputError] = useState(null);
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState(null); // { command, fromInput }
  const [favDialog, setFavDialog] = useState(null); // { type: 'form', favorite } | { type: 'delete', favorite }
  const [deleting, setDeleting] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);

  const inputRef = useRef(null);
  const outRef = useRef(null);
  const stick = useRef(true); // follow new output (the user has not scrolled up)

  // ----- data -----
  useEffect(() => {
    loadHistory();
    loadFavorites();
    api('/api/settings/dangerous-commands')
      .then((list) => Array.isArray(list) && setDangerous(list))
      .catch(() => {}); // keep the defaults: better one confirmation too many

    // Online players for autocompletion: now and every 30 s, paused while the
    // tab is hidden (and refreshed as soon as it is shown again).
    let alive = true;
    let timer = null;
    const pollPlayers = async () => {
      try {
        const result = await api(`/api/servers/${id}/players`);
        // An answer the parser did not recognize ({ raw }) has no names.
        if (alive) setPlayers(Array.isArray(result?.players) ? result.players : []);
      } catch {
        // Offline or the panel unreachable: keep the last names known.
      }
    };
    const startPolling = () => {
      if (timer !== null) return;
      pollPlayers();
      timer = setInterval(pollPlayers, PLAYERS_POLL_MS);
    };
    const stopPolling = () => {
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stopPolling() : startPolling());
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) startPolling();

    const close = openLive(id, (message) => {
      if (message?.type !== 'console' || !message.entry) return;
      const entry = message.entry;
      update((log) => addLive(log, entry));
      if (entry.origin === 'console') remember(entry.command);
    });

    if (!matchMedia('(pointer: coarse)').matches) inputRef.current?.focus();
    return () => {
      alive = false;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [id]);

  function remember(command) {
    setHistory((h) => (Array.isArray(h) ? [command, ...h.filter((c) => c !== command)].slice(0, HISTORY_LIMIT) : h));
  }

  // ----- output -----
  const visible = useMemo(() => (filter.trim() ? entries.filter((e) => matchesFilter(e, filter)) : entries), [entries, filter]);

  useLayoutEffect(() => {
    const el = outRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [visible]);

  function onScroll() {
    const el = outRef.current;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stick.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(false);
  }

  function jumpToLatest() {
    const el = outRef.current;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    inputRef.current?.focus({ preventScroll: true });
  }

  function clearScreen() {
    stick.current = true;
    setUnseen(false);
    setAtBottom(true);
    update(() => []);
  }

  function exportLog() {
    const text = formatExport(visible, (e) => t(errorKey(e.error)));
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFilename(server.name);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // A plain click on the output (not a text selection) goes back to the input.
  function onOutputPointerUp(event) {
    if (event.pointerType !== 'mouse' || getSelection()?.toString()) return;
    inputRef.current?.focus({ preventScroll: true });
  }

  function onTerminalKeyDown(event) {
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      clearScreen();
    }
  }

  // ----- running commands -----
  async function execute(command, fromInput) {
    const sendId = nextSendId();
    stick.current = true;
    update((log) => addPending(log, { id: sendId, command, ts: Date.now() }));
    if (fromInput) fill('');
    remember(command);
    try {
      const result = await api(`/api/servers/${id}/command`, { method: 'POST', body: { command, origin: 'console' } });
      update((log) => resolveSent(log, sendId, command, result));
    } catch (err) {
      update((log) => failSent(log, sendId, err.status === 404 ? 'not_found' : err.code));
    }
  }

  function run(raw, fromInput = false) {
    const command = normalizeCommand(raw);
    if (command === '') return;
    if (isDangerous(command, dangerous)) setConfirm({ command, fromInput });
    else execute(command, fromInput);
  }

  // ----- input -----
  const suggestions = useMemo(() => (open ? suggest(input, { players }) : []), [open, input, players]);
  const showList = suggestions.length > 0;
  const activeIndex = Math.min(active, suggestions.length - 1);
  const sig = useMemo(() => signature(input), [input]);
  const token = lastToken(input);

  useLayoutEffect(() => {
    if (showList) document.getElementById(`${LIST_ID}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [showList, activeIndex]);

  // Sets the input (from history, an example or after sending) without
  // opening the suggestions.
  function fill(value, focus = false) {
    setInput(value);
    setOpen(false);
    setActive(0);
    setWalk({ index: -1, draft: '' });
    setInputError(null);
    if (focus) inputRef.current?.focus();
  }

  function onInput(event) {
    setInput(event.currentTarget.value);
    setOpen(true);
    setActive(0);
    setWalk({ index: -1, draft: '' });
    setInputError(null);
  }

  function complete(suggestion) {
    setInput(applySuggestion(input, suggestion));
    setOpen(true);
    setActive(0);
    inputRef.current?.focus();
  }

  function onKeyDown(event) {
    if (showList) {
      const n = suggestions.length;
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        complete(suggestions[activeIndex]);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const list = Array.isArray(history) ? history : [];
      const step = walkHistory(walk, list, event.key === 'ArrowUp' ? 'up' : 'down', input);
      if (!step) return;
      event.preventDefault();
      // A recalled command keeps the suggestions closed, so the next ↑/↓
      // keeps walking the history instead of moving through suggestions.
      setOpen(false);
      setWalk({ index: step.index, draft: step.draft });
      setInput(step.value);
      setInputError(null);
    }
  }

  function submit(event) {
    event.preventDefault();
    const problem = commandProblem(input);
    if (problem === 'empty') return;
    if (problem) {
      setInputError(problem);
      return;
    }
    run(input, true);
  }

  // ----- favorites -----
  async function favoriteSaved(saved, edited) {
    setFavDialog(null);
    toast(t(edited ? 'console.favorites.toast.updated' : 'console.favorites.toast.created', { label: saved.label }));
    await loadFavorites();
  }

  async function deleteFavorite() {
    const favorite = favDialog.favorite;
    setDeleting(true);
    try {
      await api(`/api/servers/${id}/favorites/${favorite.id}`, { method: 'DELETE' });
    } catch (err) {
      if (err.status !== 404) {
        setDeleting(false);
        if (err.status !== 401) toast(t('console.favorites.errors.deleteFailed'), { type: 'error' });
        return;
      }
    }
    setDeleting(false);
    setFavDialog(null);
    // The button that opened the dialogs is gone: continue from the input.
    requestAnimationFrame(() => inputRef.current?.focus());
    toast(t('console.favorites.toast.deleted', { label: favorite.label }));
    await loadFavorites();
  }

  // ----- render -----
  let output;
  if (entries.length === 0) {
    output = html`<div class="cl-empty">
      <p class="cl-empty-title">${t('console.empty.title')}</p>
      <p>${t('console.empty.message')}</p>
      <div class="cl-examples">
        ${EXAMPLES.map((c) => html`<button type="button" class="cl-chip" onClick=${() => fill(c, true)}>${c}</button>`)}
      </div>
    </div>`;
  } else if (visible.length === 0) {
    output = html`<p class="cl-empty">${t('console.noMatches', { query: filter.trim() })}</p>`;
  } else {
    output = html`<${OutputLines} entries=${visible} lang=${lang} />`;
  }

  return html`<div class="page console-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.console')}</h1>
        <p class="page-subtitle">${t('console.subtitle', { name: server.name })}</p>
      </div>
      <div class="cl-tools">
        <label class="cl-filter">
          <${Icon} name="search" size=${15} />
          <span class="sr-only">${t('console.filter')}</span>
          <input
            class="input"
            type="search"
            value=${filter}
            placeholder=${t('console.filterPlaceholder')}
            onInput=${(e) => { stick.current = true; setFilter(e.currentTarget.value); }}
            autocomplete="off"
            spellcheck=${false}
          />
        </label>
        <button type="button" class="btn btn-secondary btn-sm" onClick=${exportLog} disabled=${visible.length === 0} title=${t('console.exportTitle')}>
          <${Icon} name="download" size=${15} />${t('console.export')}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onClick=${clearScreen} disabled=${entries.length === 0} title=${t('console.clearTitle')}>
          <${Icon} name="eraser" size=${15} />${t('console.clear')}
        </button>
      </div>
    </header>

    <div class="console-body">
      <div class="cl-main">
        <div class="cl-term" onKeyDown=${onTerminalKeyDown}>
          <div class="cl-out-wrap">
            <div
              ref=${outRef}
              class="cl-out"
              role="log"
              aria-label=${t('console.outputLabel')}
              tabindex="0"
              onScroll=${onScroll}
              onPointerUp=${onOutputPointerUp}
            >
              ${output}
            </div>
            ${!atBottom &&
            html`<button type="button" class=${`cl-jump ${unseen ? 'cl-jump-new' : ''}`} onClick=${jumpToLatest}>
              <${Icon} name="arrowDown" size=${14} />${t(unseen ? 'console.newOutput' : 'console.jump')}
            </button>`}
          </div>

          <div class="cl-prompt-area">
            ${showList &&
            html`<div class="cl-suggest">
              <ul id=${LIST_ID} role="listbox" aria-label=${t('console.suggest.label')}>
                ${suggestions.map(
                  (s, i) => html`<li
                    key=${s.insert}
                    id=${`${LIST_ID}-${i}`}
                    role="option"
                    aria-selected=${i === activeIndex ? 'true' : 'false'}
                    class=${`cl-option ${i === activeIndex ? 'active' : ''}`}
                    onMouseDown=${(e) => { e.preventDefault(); complete(s); }}
                  >
                    <${Highlighted} label=${s.label} token=${token} />
                    ${s.detail && html`<span class="cl-option-detail">${t(s.detail)}</span>`}
                  </li>`,
                )}
              </ul>
              <p class="cl-suggest-hint" aria-hidden="true">
                <kbd>Tab</kbd> ${t('console.suggest.complete')} · <kbd>↑</kbd><kbd>↓</kbd> ${t('console.suggest.choose')} · <kbd>Esc</kbd> ${t('console.suggest.close')}
              </p>
            </div>`}
            ${sig && html`<${Signature} sig=${sig} />`}
            <form class="cl-input-row" onSubmit=${submit}>
              <span class="cl-prompt" aria-hidden="true">›</span>
              <input
                ref=${inputRef}
                id="console-input"
                class="cl-input"
                type="text"
                value=${input}
                placeholder=${t('console.placeholder')}
                onInput=${onInput}
                onKeyDown=${onKeyDown}
                onBlur=${() => setOpen(false)}
                role="combobox"
                aria-label=${t('console.inputLabel')}
                aria-autocomplete="list"
                aria-expanded=${showList ? 'true' : 'false'}
                aria-controls=${showList ? LIST_ID : undefined}
                aria-activedescendant=${showList ? `${LIST_ID}-${activeIndex}` : undefined}
                aria-invalid=${inputError ? 'true' : undefined}
                aria-describedby=${inputError ? 'console-input-error' : undefined}
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck=${false}
                enterkeyhint="send"
              />
              <button type="submit" class="btn btn-primary btn-sm cl-send" disabled=${input.trim() === ''}>
                <span>${t('console.send')}</span><${Icon} name="enter" size=${14} />
              </button>
            </form>
            ${inputError && html`<p id="console-input-error" class="cl-input-error" role="alert">${t(errorKey(inputError))}</p>`}
          </div>
        </div>
        <p class="cl-note"><${Icon} name="info" size=${14} />${t('console.rconNote')}</p>
      </div>

      <aside class="cl-side">
        <${Favorites}
          favorites=${favorites}
          onRun=${(command) => run(command)}
          onAdd=${() => setFavDialog({ type: 'form', favorite: null })}
          onEdit=${(favorite) => setFavDialog({ type: 'form', favorite })}
          onRetry=${loadFavorites}
        />
        <${History} history=${history} onPick=${(command) => fill(command, true)} onRetry=${loadHistory} />
      </aside>
    </div>

    ${confirm &&
    html`<${Confirm}
      title=${t('console.confirm.title')}
      message=${html`<p class="confirm-message">${t('console.confirm.message')}</p>
        <code class="cl-confirm-cmd">${confirm.command}</code>
        <p class="hint">${t('console.confirm.hint')}</p>`}
      confirmLabel=${t('console.confirm.run')}
      danger
      onConfirm=${() => { const { command, fromInput } = confirm; setConfirm(null); execute(command, fromInput); }}
      onCancel=${() => setConfirm(null)}
    />`}
    ${favDialog?.type === 'form' &&
    html`<${FavoriteForm}
      key=${favDialog.favorite?.id ?? 'new'}
      serverId=${id}
      favorite=${favDialog.favorite}
      initialCommand=${normalizeCommand(input)}
      onClose=${() => setFavDialog(null)}
      onSaved=${favoriteSaved}
      onDelete=${(favorite) => setFavDialog({ type: 'delete', favorite })}
    />`}
    ${favDialog?.type === 'delete' &&
    html`<${Confirm}
      title=${t('console.favorites.delete.title', { label: favDialog.favorite.label })}
      message=${t('console.favorites.delete.message')}
      confirmLabel=${t('common.delete')}
      danger
      busy=${deleting}
      onConfirm=${deleteFavorite}
      onCancel=${() => setFavDialog(null)}
    />`}
  </div>`;
}

export function Console() {
  return html`<${ActiveServer} titleKey="nav.console" view=${(server) => html`<${ConsoleView} key=${server.id} server=${server} />`} />`;
}
