// UI translations. Every visible string comes from locales/<code>.json, whose
// keys are namespaced ("nav.dashboard", "login.title"). To add a language,
// create its JSON file and register it here: nothing else needs to change.
export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
];

const DEFAULT_LANG = 'en';
const STORAGE_KEY = 'craftrcon.lang';

const isRegistered = (code) => LANGUAGES.some((l) => l.code === code);
const dictionaries = {}; // code -> parsed JSON
const pending = {}; // code -> Promise, so concurrent loads share one fetch

function readStoredLang() {
  try {
    const code = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isRegistered(code) ? code : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG; // storage blocked (private mode, sandboxed frame)
  }
}

let current = readStoredLang();

export async function loadLocale(code) {
  if (dictionaries[code]) return;
  pending[code] ??= (async () => {
    const res = await fetch(`/locales/${code}.json`);
    if (!res.ok) throw new Error(`Could not load locale "${code}" (HTTP ${res.status})`);
    dictionaries[code] = await res.json();
  })().finally(() => delete pending[code]);
  return pending[code];
}

export const getLang = () => current;

// Loads the language (and English, the fallback) before switching to it, so
// t() never runs against a half-loaded dictionary. Unknown codes are ignored.
export async function setLang(code) {
  if (!isRegistered(code)) return;
  await Promise.all([loadLocale(DEFAULT_LANG), loadLocale(code)]);
  current = code;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, code);
  } catch {
    // Not persisted; the choice still applies until the page reloads.
  }
  if (globalThis.document) document.documentElement.lang = code;
}

function lookup(dict, key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

// Translates `key` in the current language, then English, then returns the
// key itself. "{name}" placeholders are replaced from `vars`.
export function t(key, vars) {
  const message = lookup(dictionaries[current], key) ?? lookup(dictionaries[DEFAULT_LANG], key) ?? key;
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
