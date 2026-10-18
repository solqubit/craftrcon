import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, verifyPassword } from '../src/security/password.js';
import { loadOrCreateKey, encryptSecret, decryptSecret } from '../src/security/secretbox.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'craftrcon-sec-'));
}

test('hashPassword uses the documented scrypt format', async () => {
  const stored = await hashPassword('correct horse');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '16384', '8', '1']);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16);
  assert.equal(Buffer.from(parts[5], 'base64').length, 64);
});

test('verifyPassword accepts the right password and rejects another', async () => {
  const stored = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
});

test('two hashes of the same password differ (salt)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
});

test('verifyPassword returns false for malformed stored values', async () => {
  for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$16384$8$1$AAAA$AAAA', 'scrypt$x$8$1$AAAA$AAAA', null, undefined]) {
    assert.equal(await verifyPassword('whatever', bad), false);
  }
});

test('encryptSecret/decryptSecret round-trips unicode', () => {
  const key = loadOrCreateKey(path.join(tmpDir(), 'secret.key'));
  const blob = encryptSecret(key, 'contraseña_ñ');
  assert.match(blob, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(decryptSecret(key, blob), 'contraseña_ñ');
});

test('encryptSecret uses a fresh 12-byte IV each time', () => {
  const key = loadOrCreateKey(path.join(tmpDir(), 'secret.key'));
  const a = encryptSecret(key, 'x');
  const b = encryptSecret(key, 'x');
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a.split(':')[1], 'base64').length, 12);
});

test('decryptSecret throws when the ciphertext is tampered with', () => {
  const key = loadOrCreateKey(path.join(tmpDir(), 'secret.key'));
  const [v, iv, tag, ct] = encryptSecret(key, 'secret-value').split(':');
  const bytes = Buffer.from(ct, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(() => decryptSecret(key, [v, iv, tag, bytes.toString('base64')].join(':')));
});

test('decryptSecret throws with a different key or a malformed blob', () => {
  const dir = tmpDir();
  const k1 = loadOrCreateKey(path.join(dir, 'a.key'));
  const k2 = loadOrCreateKey(path.join(dir, 'b.key'));
  const blob = encryptSecret(k1, 'secret-value');
  assert.throws(() => decryptSecret(k2, blob));
  assert.throws(() => decryptSecret(k1, 'nonsense'));
  assert.throws(() => decryptSecret(k1, 'v2:a:b:c'));
});

test('loadOrCreateKey returns the same 32-byte key on repeated calls', () => {
  const file = path.join(tmpDir(), 'nested', 'dir', 'secret.key');
  const first = loadOrCreateKey(file);
  const second = loadOrCreateKey(file);
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
});

test('loadOrCreateKey rejects an existing key file of the wrong size', () => {
  const file = path.join(tmpDir(), 'secret.key');
  fs.writeFileSync(file, Buffer.alloc(10));
  assert.throws(() => loadOrCreateKey(file), /32 bytes/);
});

test('key file is created with mode 0o600', { skip: process.platform === 'win32' }, () => {
  const file = path.join(tmpDir(), 'secret.key');
  loadOrCreateKey(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
