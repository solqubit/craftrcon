const PRUNE_THRESHOLD = 1000;

// In-memory login throttle keyed by client IP. After `maxFails` consecutive
// failures the IP is locked; every new lock doubles the wait, up to maxLockMs.
//
// An allowed check() reserves an attempt slot ("pending") that fail(),
// success() or release() settles. Failures plus in-flight attempts count
// against the limit, so a burst of concurrent requests cannot exceed it while
// the slow password hash is still running.
export function createRateLimiter({
  maxFails = 5,
  baseLockMs = 60_000,
  maxLockMs = 30 * 60_000,
  now = Date.now,
} = {}) {
  const entries = new Map(); // ip -> { fails, pending, locks, lockedUntil, touched }

  const nextLockMs = (locks) => Math.min(baseLockMs * 2 ** locks, maxLockMs);

  function prune(ts) {
    for (const [ip, e] of entries) {
      if (e.pending === 0 && e.lockedUntil <= ts && ts - e.touched > maxLockMs * 2) entries.delete(ip);
    }
  }

  function entryFor(ip, ts) {
    let e = entries.get(ip);
    if (!e) {
      if (entries.size >= PRUNE_THRESHOLD) prune(ts);
      e = { fails: 0, pending: 0, locks: 0, lockedUntil: 0, touched: ts };
      entries.set(ip, e);
    }
    e.touched = ts;
    return e;
  }

  function check(ip) {
    const ts = now();
    const e = entryFor(ip, ts);
    if (e.lockedUntil > ts) return { allowed: false, retryAfterMs: e.lockedUntil - ts };
    if (e.fails + e.pending >= maxFails) return { allowed: false, retryAfterMs: nextLockMs(e.locks) };
    e.pending += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  function settle(e) {
    if (e.pending > 0) e.pending -= 1;
  }

  function fail(ip) {
    const ts = now();
    const e = entryFor(ip, ts);
    settle(e);
    e.fails += 1;
    if (e.fails >= maxFails) {
      e.lockedUntil = ts + nextLockMs(e.locks);
      e.locks += 1;
      e.fails = 0;
    }
  }

  function success(ip) {
    const e = entries.get(ip);
    if (!e) return;
    settle(e);
    e.fails = 0;
    e.locks = 0;
    e.lockedUntil = 0;
    if (e.pending === 0) entries.delete(ip);
  }

  // Frees a reserved slot without recording an outcome (e.g. internal error).
  function release(ip) {
    const e = entries.get(ip);
    if (e) settle(e);
  }

  return { check, fail, success, release };
}
