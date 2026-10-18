import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (code) => JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));

// Every leaf as a dotted path ("nav.dashboard"). Leaves must be strings.
function keysOf(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) keys.push(...keysOf(v, path));
    else {
      assert.equal(typeof v, 'string', `${path} must be a string`);
      assert.notEqual(v.trim(), '', `${path} must not be empty`);
      keys.push(path);
    }
  }
  return keys;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('en.json and es.json have exactly the same keys', () => {
  const en = keysOf(load('en')).sort();
  const es = keysOf(load('es')).sort();
  const missingInEs = en.filter((k) => !es.includes(k));
  const extraInEs = es.filter((k) => !en.includes(k));
  assert.deepEqual({ missingInEs, extraInEs }, { missingInEs: [], extraInEs: [] });
});

test('translations use the same placeholders as English', () => {
  const en = load('en');
  const es = load('es');
  const get = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);
  for (const key of keysOf(en)) {
    assert.deepEqual(placeholders(get(es, key)), placeholders(get(en, key)), key);
  }
});
