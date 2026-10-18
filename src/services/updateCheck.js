export const DEFAULT_VERSION_URL = 'https://raw.githubusercontent.com/solqubit/craftrcon/main/VERSION';
const TIMEOUT_MS = 3000;
const SUCCESS_TTL_MS = 6 * 3600e3;
const FAILURE_TTL_MS = 10 * 60e3;
const MAX_BODY_CHARS = 64;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(text) {
  const match = typeof text === 'string' ? SEMVER.exec(text.trim()) : null;
  if (!match) return null;
  return { core: [match[1], match[2], match[3]].map(Number), pre: match[4] ? match[4].split('.') : [] };
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

// Semver precedence: -1 if a < b, 0 if equal, 1 if a > b. A prerelease sorts
// below its release; build metadata is ignored. Throws on a malformed version.
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new TypeError(`invalid semver: ${left ? b : a}`);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return sign(left.core[i] - right.core[i]);
  }
  if (left.pre.length === 0 || right.pre.length === 0) return sign(right.pre.length - left.pre.length);
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return sign(Number(x) - Number(y));
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// Looks up the latest published version. The answer is cached (a failure only
// briefly, so a network blip doesn't hide an update for hours). Never throws:
// no network or a bad answer means `latest: null`.
export function createUpdateCheck({
  current,
  fetchImpl = globalThis.fetch,
  url = DEFAULT_VERSION_URL,
  ttlMs = SUCCESS_TTL_MS,
  failureTtlMs = FAILURE_TTL_MS,
  timeoutMs = TIMEOUT_MS,
  now = Date.now,
} = {}) {
  let cached = null; // { latest, expires }
  let inflight = null;

  async function fetchLatest() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text.length <= MAX_BODY_CHARS && parseSemver(text) ? text.replace(/^v/, '') : null;
    } catch {
      return null;
    }
  }

  function describe(latest) {
    let updateAvailable = false;
    if (latest !== null && parseSemver(current)) updateAvailable = compareSemver(latest, current) === 1;
    return { installed: current, latest, updateAvailable };
  }

  async function check() {
    if (cached && now() < cached.expires) return describe(cached.latest);
    inflight ??= fetchLatest()
      .then((latest) => {
        cached = { latest, expires: now() + (latest === null ? failureTtlMs : ttlMs) };
        return latest;
      })
      .finally(() => {
        inflight = null;
      });
    return describe(await inflight);
  }

  return { check };
}
