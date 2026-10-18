import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidPlayerName } from '../../public/js/lib/names.js';

// The only place that names the skin service.
export const HEAD_SOURCE = (name) => `https://mc-heads.net/avatar/${name}/32`;

const FETCH_TIMEOUT_MS = 3000;
const MAX_BYTES = 256 * 1024;

// Reads the body, giving up as soon as it exceeds MAX_BYTES. Resolves null for
// anything that is not an acceptable PNG response.
async function readPng(response) {
  if (!response.ok) return null;
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/png')) return null;
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES || !response.body) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return size > 0 ? Buffer.concat(chunks) : null;
}

// Disk-backed cache of player heads in `dir`, one `<lowercase name>.png` each,
// fresh for `ttlMs` by file mtime. `get(name)` resolves { type: 'png', buffer }
// or { type: 'fallback' } and never rejects. The name must already be valid:
// callers check isValidPlayerName before any disk or network access.
export function createHeads({ dir, fetchImpl = fetch, ttlMs = 24 * 3600e3 }) {
  const inflight = new Map();

  async function download(name) {
    try {
      const response = await fetchImpl(HEAD_SOURCE(name), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      return await readPng(response);
    } catch {
      return null;
    }
  }

  async function load(key, name) {
    const file = join(dir, `${key}.png`);
    let cachedAt = null;
    try {
      cachedAt = (await stat(file)).mtimeMs;
    } catch {
      // not cached yet
    }
    if (cachedAt !== null && Date.now() - cachedAt < ttlMs) {
      try {
        return { type: 'png', buffer: await readFile(file) };
      } catch {
        // vanished or unreadable: fall through and refetch
      }
    }

    const buffer = await download(name);
    if (buffer) {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, buffer);
        await rename(tmp, file);
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
      }
      return { type: 'png', buffer };
    }
    // Source unreachable: prefer an expired copy over the generic head.
    if (cachedAt !== null) {
      try {
        return { type: 'png', buffer: await readFile(file) };
      } catch {
        // fall through
      }
    }
    return { type: 'fallback' };
  }

  async function get(name) {
    if (!isValidPlayerName(name)) return { type: 'fallback' };
    const key = name.toLowerCase();
    let pending = inflight.get(key);
    if (!pending) {
      pending = load(key, name).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  return { get };
}
