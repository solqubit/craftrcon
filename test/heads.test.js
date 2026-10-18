import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeads, HEAD_SOURCE } from '../src/services/heads.js';
import { makeApp } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');

function png(body = PNG, headers = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/png', ...headers } });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'craftrcon-heads-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spyFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

const down = async () => {
  throw new Error('network down');
};

test('HEAD_SOURCE is the single place naming the skin service', () => {
  assert.equal(HEAD_SOURCE('Notch'), 'https://mc-heads.net/avatar/Notch/32');
});

test('the first call downloads, the second comes from the cache', async (t) => {
  const dir = tempDir(t);
  const fetchImpl = spyFetch(() => png());
  const heads = createHeads({ dir, fetchImpl });
  const first = await heads.get('Notch');
  assert.equal(first.type, 'png');
  assert.deepEqual(first.buffer, PNG);
  const second = await heads.get('NOTCH');
  assert.equal(second.type, 'png');
  assert.deepEqual(second.buffer, PNG);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, HEAD_SOURCE('Notch'));
  assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal);
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
  assert.deepEqual(readdirSync(dir), ['notch.png']);
});

test('creates the cache directory on demand', async (t) => {
  const dir = join(tempDir(t), 'nested', 'heads');
  const heads = createHeads({ dir, fetchImpl: spyFetch(() => png()) });
  assert.equal(existsSync(dir), false);
  await heads.get('Steve_1');
  assert.deepEqual(readdirSync(dir), ['steve_1.png']);
});

test('a throwing fetchImpl gives the fallback and caches nothing', async (t) => {
  const dir = tempDir(t);
  const heads = createHeads({ dir, fetchImpl: down });
  assert.deepEqual(await heads.get('Notch'), { type: 'fallback' });
  assert.deepEqual(readdirSync(dir), []);
});

test('rejects non-ok, non-PNG and oversized responses without caching them', async (t) => {
  const dir = tempDir(t);
  const cases = [
    new Response('nope', { status: 404, headers: { 'content-type': 'image/png' } }),
    new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response(Buffer.alloc(256 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/png' } }),
    new Response(Buffer.alloc(10), { status: 200 }),
  ];
  for (const response of cases) {
    const heads = createHeads({ dir, fetchImpl: async () => response });
    assert.deepEqual(await heads.get('Notch'), { type: 'fallback' });
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('releases the body of every response rejected before reading', async (t) => {
  const dir = tempDir(t);
  const cases = [
    { status: 404, headers: { 'content-type': 'image/png' } },
    { status: 200, headers: { 'content-type': 'text/html' } },
    { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(256 * 1024 + 1) } },
  ];
  for (const init of cases) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const heads = createHeads({ dir, fetchImpl: async () => new Response(body, init) });
    assert.deepEqual(await heads.get('Notch'), { type: 'fallback' });
    assert.equal(cancelled, true, JSON.stringify(init));
  }
});

test('accepts a body of exactly 256 KiB', async (t) => {
  const dir = tempDir(t);
  const body = Buffer.alloc(256 * 1024, 1);
  const heads = createHeads({ dir, fetchImpl: async () => png(body) });
  const result = await heads.get('Notch');
  assert.equal(result.type, 'png');
  assert.equal(result.buffer.length, body.length);
});

test('concurrent requests for the same name share one fetch', async (t) => {
  const dir = tempDir(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const fetchImpl = spyFetch(async () => {
    await gate;
    return png();
  });
  const heads = createHeads({ dir, fetchImpl });
  const pending = [heads.get('Notch'), heads.get('notch'), heads.get('NOTCH')];
  release();
  const results = await Promise.all(pending);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(results.every((r) => r.type === 'png'));
});

test('a stale entry is refetched; if that fails the stale file is served', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'notch.png');
  writeFileSync(file, 'old-bytes');
  const past = new Date(Date.now() - 25 * 3600e3);
  utimesSync(file, past, past);

  const refreshed = spyFetch(() => png());
  assert.deepEqual((await createHeads({ dir, fetchImpl: refreshed }).get('Notch')).buffer, PNG);
  assert.equal(refreshed.calls.length, 1);

  utimesSync(file, past, past);
  const stale = await createHeads({ dir, fetchImpl: down }).get('Notch');
  assert.equal(stale.type, 'png');
  assert.deepEqual(stale.buffer, PNG); // the file refreshed above, aged again
});

test('a fresh entry honours ttlMs', async (t) => {
  const dir = tempDir(t);
  const fetchImpl = spyFetch(() => png());
  const heads = createHeads({ dir, fetchImpl, ttlMs: 60_000 });
  await heads.get('Notch');
  await heads.get('Notch');
  assert.equal(fetchImpl.calls.length, 1);
  const past = new Date(Date.now() - 61_000);
  utimesSync(join(dir, 'notch.png'), past, past);
  await heads.get('Notch');
  assert.equal(fetchImpl.calls.length, 2);
});

async function setup(t, fetchImpl) {
  const heads = createHeads({ dir: tempDir(t), fetchImpl });
  const ctx = await makeApp({ services: { heads } });
  t.after(() => ctx.app.close());
  const headers = await ctx.login();
  const call = (name) =>
    ctx.app.inject({ method: 'GET', url: `/api/heads/${encodeURIComponent(name)}`, headers });
  return { ...ctx, headers, call };
}

test('GET /api/heads/:name serves the PNG with caching headers', async (t) => {
  const { call } = await setup(t, spyFetch(() => png()));
  const res = await call('Notch');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'max-age=86400');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.rawPayload, PNG);
});

test('GET /api/heads/:name serves the SVG fallback when the download fails', async (t) => {
  const { call } = await setup(t, down);
  const res = await call('Notch');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^image\/svg\+xml/);
  assert.equal(res.headers['cache-control'], 'max-age=3600');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.body, /^<svg[\s>]/);
});

test('malicious or malformed names get 400 without touching disk or network', async (t) => {
  const fetchImpl = spyFetch(() => png());
  const { call, services } = await setup(t, fetchImpl);
  let serviceCalls = 0;
  const original = services.heads.get;
  services.heads.get = (...args) => {
    serviceCalls += 1;
    return original(...args);
  };
  for (const name of ['../../etc/passwd', 'a'.repeat(17), 'a'.repeat(300), 'bad name', '..%2f..%2fx', 'a.b', 'a/b', '']) {
    const res = await call(name);
    assert.equal(res.statusCode, 400, name);
    assert.deepEqual(res.json(), { error: 'invalid_name' });
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(serviceCalls, 0);
});

test('GET /api/heads/:name requires a session', async (t) => {
  const { app } = await setup(t, spyFetch(() => png()));
  const res = await app.inject({ method: 'GET', url: '/api/heads/Notch' });
  assert.equal(res.statusCode, 401);
});
