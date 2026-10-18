const PRUNE_THRESHOLD = 1000;

// In-memory login throttle keyed by client IP. After `maxFails` consecutive
// failures the IP is locked; every new lock doubles the wait, up to maxLockMs.
export function createRateLimiter({
  maxFails = 5,
  baseLockMs = 60_000,
  maxLockMs = 30 * 60_000,
  now = Date.now,
} = {}) {
  const entries = new Map(); // ip -> { fails, locks, lockedUntil, touched }

  function prune(ts) {
    for (const [ip, e] of entries) {
      if (e.lockedUntil <= ts && ts - e.touched > maxLockMs * 2) entries.delete(ip);
    }
  }

  function check(ip) {
    const e = entries.get(ip);
    const ts = now();
    if (e && e.lockedUntil > ts) return { allowed: false, retryAfterMs: e.lockedUntil - ts };
    return { allowed: true, retryAfterMs: 0 };
  }

  function fail(ip) {
    const ts = now();
    if (entries.size >= PRUNE_THRESHOLD) prune(ts);
    const e = entries.get(ip) ?? { fails: 0, locks: 0, lockedUntil: 0, touched: ts };
    e.touched = ts;
    e.fails += 1;
    if (e.fails >= maxFails) {
      e.lockedUntil = ts + Math.min(baseLockMs * 2 ** e.locks, maxLockMs);
      e.locks += 1;
      e.fails = 0;
    }
    entries.set(ip, e);
  }

  function success(ip) {
    entries.delete(ip);
  }

  return { check, fail, success };
}
