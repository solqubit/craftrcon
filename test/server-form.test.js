import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RCON_ERRORS,
  buildPayload,
  buildTestPayload,
  fieldErrorKey,
  initialValues,
  parsePort,
  targetChanged,
  testResultKey,
  validate,
  validateForTest,
} from '../public/js/lib/servers.js';
import { ICONS, COLORS } from '../src/services/servers.js';
import * as client from '../public/js/lib/servers.js';

const saved = { id: 3, name: 'Survival', host: 'Play.Example.net', rconPort: 25575, gamePort: 25565, icon: 'sword', color: 'rose' };
const filled = { ...initialValues(), name: 'Mine', host: 'mc.local', password: 'secret' };

test('icons and colors match the backend lists', () => {
  assert.deepEqual(client.ICONS, ICONS);
  assert.deepEqual(client.COLORS, COLORS);
});

test('initialValues: defaults for a new server, saved values (no password) for an edit', () => {
  assert.deepEqual(initialValues(), {
    name: '', host: '', rconPort: '25575', password: '', gamePort: '25565', icon: 'mountain', color: 'emerald',
  });
  assert.deepEqual(initialValues(saved), {
    name: 'Survival', host: 'Play.Example.net', rconPort: '25575', password: '', gamePort: '25565', icon: 'sword', color: 'rose',
  });
});

test('parsePort accepts whole ports 1-65535 only', () => {
  assert.equal(parsePort('25575'), 25575);
  assert.equal(parsePort(' 80 '), 80);
  for (const bad of ['', '0', '65536', '-1', '12.5', '1e3', 'abc', '123456']) assert.equal(parsePort(bad), null, bad);
});

test('validate: a complete new server passes', () => {
  assert.deepEqual(validate(filled), {});
});

test('validate: required, too_long and invalid codes', () => {
  const errors = validate({ ...filled, name: ' ', host: 'h'.repeat(256), rconPort: '0', gamePort: 'x', password: '' });
  assert.deepEqual(errors, { name: 'required', host: 'too_long', rconPort: 'invalid', gamePort: 'invalid', password: 'required' });
  assert.equal(validate({ ...filled, name: 'n'.repeat(33) }).name, 'too_long');
  assert.equal(validate({ ...filled, password: 'p'.repeat(513) }).password, 'too_long');
});

test('validate (edit): an empty password keeps the saved one while host and port are unchanged', () => {
  const values = { ...initialValues(saved), host: 'play.example.NET' };
  assert.deepEqual(validate(values, saved), {});
});

test('validate (edit): changing host or RCON port needs the password again (R13)', () => {
  assert.deepEqual(validate({ ...initialValues(saved), host: 'other.net' }, saved), { password: 'required' });
  assert.deepEqual(validate({ ...initialValues(saved), rconPort: '25580' }, saved), { password: 'required' });
  assert.deepEqual(validate({ ...initialValues(saved), rconPort: '25580', password: 'x' }, saved), {});
});

test('targetChanged ignores host case and other fields', () => {
  assert.equal(targetChanged({ ...initialValues(saved), name: 'Other', gamePort: '1' }, saved), false);
  assert.equal(targetChanged(initialValues(), null), false);
});

test('buildPayload trims, converts ports and omits an empty password', () => {
  assert.deepEqual(buildPayload({ ...filled, name: ' Mine ', host: ' mc.local ', password: '' }), {
    name: 'Mine', host: 'mc.local', rconPort: 25575, gamePort: 25565, icon: 'mountain', color: 'emerald',
  });
  assert.equal(buildPayload(filled).password, 'secret');
});

test('buildTestPayload sends the id only when editing and the password only when typed', () => {
  assert.deepEqual(buildTestPayload(filled), { host: 'mc.local', rconPort: 25575, password: 'secret' });
  assert.deepEqual(buildTestPayload(initialValues(saved), saved), { host: 'Play.Example.net', rconPort: 25575, id: 3 });
});

test('validateForTest only reports the fields a test needs', () => {
  assert.deepEqual(validateForTest({ ...filled, name: '', gamePort: 'x', password: '' }), { password: 'required' });
  assert.deepEqual(validateForTest({ ...filled, host: '' }), { host: 'required' });
});

test('fieldErrorKey: a missing password on edit explains the retype rule', () => {
  assert.equal(fieldErrorKey('password', 'required', { editing: true }), 'servers.errors.passwordRetype');
  assert.equal(fieldErrorKey('password', 'required'), 'servers.errors.required');
  assert.equal(fieldErrorKey('host', 'too_long'), 'servers.errors.too_long');
  assert.equal(fieldErrorKey('host', 'whatever'), 'servers.errors.invalid');
});

test('testResultKey has one message per RconError code', () => {
  assert.equal(testResultKey({ ok: true, latencyMs: 4 }), 'servers.test.ok');
  for (const code of RCON_ERRORS) assert.equal(testResultKey({ ok: false, error: code }), `servers.test.error.${code}`);
  assert.equal(testResultKey({ ok: false, error: 'SOMETHING_NEW' }), 'servers.test.error.CLOSED');
});

test('every icon, color and RCON error has a message in both languages', async () => {
  const { readFileSync } = await import('node:fs');
  for (const code of ['en', 'es']) {
    const dict = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8')).servers;
    for (const icon of ICONS) assert.ok(dict.icons[icon], `${code} icon ${icon}`);
    for (const color of COLORS) assert.ok(dict.colors[color], `${code} color ${color}`);
    for (const err of RCON_ERRORS) assert.ok(dict.test.error[err], `${code} error ${err}`);
  }
});
