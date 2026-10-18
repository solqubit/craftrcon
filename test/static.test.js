import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function assertHtmlShell(res) {
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /<div id="app">/);
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
}

test('serves the SPA shell at / without a session, with security headers', async () => {
  const { app } = await makeApp();
  assertHtmlShell(await app.inject({ method: 'GET', url: '/' }));
});

test('index.html has no inline scripts', async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/' });
  for (const [, attrs, body] of res.body.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(attrs, /\bsrc="/);
    assert.equal(body.trim(), '');
  }
});

test('falls back to index.html for unknown paths outside /api/', async () => {
  const { app } = await makeApp();
  assertHtmlShell(await app.inject({ method: 'GET', url: '/dashboard' }));
  assertHtmlShell(await app.inject({ method: 'GET', url: '/some/deep/link' }));
});

test('serves static assets and locales without a session', async () => {
  const { app } = await makeApp();
  const js = await app.inject({ method: 'GET', url: '/js/main.js' });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.equal(js.headers['x-content-type-options'], 'nosniff');

  const vendor = await app.inject({ method: 'GET', url: '/vendor/htm-preact.js' });
  assert.equal(vendor.statusCode, 200);

  const css = await app.inject({ method: 'GET', url: '/css/app.css' });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /^text\/css/);

  const en = await app.inject({ method: 'GET', url: '/locales/en.json' });
  assert.equal(en.statusCode, 200);
  assert.equal(typeof en.json().nav.dashboard, 'string');
  const es = await app.inject({ method: 'GET', url: '/locales/es.json' });
  assert.equal(es.statusCode, 200);
});

test('a missing file is a 404, not the SPA shell', async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/js/missing.js' });
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.body, /<div id="app">/);
  const locale = await app.inject({ method: 'GET', url: '/locales/xx.json' });
  assert.equal(locale.statusCode, 404);
});

test('unknown /api/ paths stay JSON 404s', async () => {
  const { app } = await makeApp();
  for (const method of ['GET', 'POST']) {
    for (const url of ['/api/does-not-exist', '/%61pi/does-not-exist', '/api']) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 404, `${method} ${url}`);
      assert.deepEqual(res.json(), { error: 'not_found' });
    }
  }
});

test('non-GET requests outside /api/ are not answered with the shell', async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: 'POST', url: '/dashboard' });
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.body, /<div id="app">/);
});

test('API routes still require a session', async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/servers' });
  assert.equal(res.statusCode, 401);
});
