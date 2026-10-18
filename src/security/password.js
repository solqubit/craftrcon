import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8;

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAXMEM = 64 * 1024 * 1024;

function derive(plain, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, KEY_BYTES, { N: n, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(plain, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map((v) => (/^\d+$/.test(v) ? Number(v) : NaN));
  if (![n, r, p].every((v) => Number.isSafeInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  try {
    const actual = await derive(plain, salt, n, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
