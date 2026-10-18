import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

export function loadOrCreateKey(file) {
  let key;
  try {
    key = fs.readFileSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    key = randomBytes(KEY_BYTES);
    try {
      fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      key = fs.readFileSync(file); // lost a creation race: use the winner's key
    }
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid key file ${file}: expected ${KEY_BYTES} bytes, found ${key.length}`);
  }
  return key;
}

export function encryptSecret(key, plain) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(key, blob) {
  const parts = typeof blob === 'string' ? blob.split(':') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Invalid secret blob');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid secret blob');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
