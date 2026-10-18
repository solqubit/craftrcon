import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// i18n.js runs in the browser: it fetches /locales/<code>.json and keeps the
// chosen language in localStorage. Both are stubbed here with fixture locales
// that deliberately differ, which the real files never may (see locales.test.js).
const LOCALES = {
  en: {
    greet: 'Hello, {name}!',
    count: '{n} of {max}',
    nested: { onlyEnglish: 'Only in English' },
  },
  es: {
    greet: '¡Hola, {name}!',
    count: '{n} de {max}',
  },
};

const stored = new Map();
const originalFetch = globalThis.fetch;
const fetched = [];
let i18n;

before(async () => {
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const code = /^\/locales\/(\w+)\.json$/.exec(url)?.[1];
    if (!code || !(code in LOCALES)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(LOCALES[code]) };
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: (k) => stored.delete(k),
    },
  });
  i18n = await import('../public/js/i18n.js');
});

after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.localStorage;
});

test('LANGUAGES registers English and Spanish', () => {
  assert.deepEqual(i18n.LANGUAGES, [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
  ]);
});

test('defaults to English and interpolates variables', async () => {
  assert.equal(i18n.getLang(), 'en');
  await i18n.setLang('en');
  assert.equal(i18n.t('greet', { name: 'Steve' }), 'Hello, Steve!');
  assert.equal(i18n.t('count', { n: 3, max: 20 }), '3 of 20');
});

test('leaves unknown placeholders untouched', async () => {
  await i18n.setLang('en');
  assert.equal(i18n.t('greet'), 'Hello, {name}!');
  assert.equal(i18n.t('count', { n: 0 }), '0 of {max}');
});

test('setLang switches language and persists the choice', async () => {
  await i18n.setLang('es');
  assert.equal(i18n.getLang(), 'es');
  assert.equal(stored.get('craftrcon.lang'), 'es');
  assert.equal(i18n.t('greet', { name: 'Ana' }), '¡Hola, Ana!');
  assert.equal(i18n.t('count', { n: 1, max: 5 }), '1 de 5');
});

test('falls back to English when the key is missing in Spanish', async () => {
  await i18n.setLang('es');
  assert.equal(i18n.t('nested.onlyEnglish'), 'Only in English');
});

test('returns the key itself when it is missing in both languages', async () => {
  await i18n.setLang('es');
  assert.equal(i18n.t('nope.missing'), 'nope.missing');
  // A namespace (object) is not a message either.
  assert.equal(i18n.t('nested'), 'nested');
});

test('loadLocale fetches each locale once', async () => {
  fetched.length = 0;
  await i18n.loadLocale('es');
  await i18n.loadLocale('en');
  assert.deepEqual(fetched, []);
});

test('setLang ignores languages that are not registered', async () => {
  await i18n.setLang('es');
  await i18n.setLang('xx');
  assert.equal(i18n.getLang(), 'es');
  assert.equal(stored.get('craftrcon.lang'), 'es');
});
