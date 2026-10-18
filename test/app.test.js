import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('health returns ok and version', async () => {
  const app = buildApp({ config: { ...loadConfig({}), version: '0.1.0' }, db: null, services: {} });
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, version: '0.1.0' });
});
