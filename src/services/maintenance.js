export const AUDIT_RETENTION_MS = 90 * 24 * 3600e3;
export const MAINTENANCE_INTERVAL_MS = 24 * 3600e3;
export const FIRST_RUN_DELAY_MS = 60e3;

// Daily housekeeping on one unref'd timer: drops audit rows older than the
// retention and sessions idle past their limit. Runs once shortly after start
// and then every 24 h. Kept apart from the sampler, which ticks every minute.
export function createMaintenance({
  audit,
  sessions,
  retentionMs = AUDIT_RETENTION_MS,
  intervalMs = MAINTENANCE_INTERVAL_MS,
  firstRunDelayMs = FIRST_RUN_DELAY_MS,
  log = null,
}) {
  let firstTimer = null;
  let timer = null;

  function run() {
    try {
      return { audit: audit.purge(retentionMs), sessions: sessions.purgeIdle() };
    } catch (err) {
      log?.error({ err }, 'maintenance failed');
      return null;
    }
  }

  function start() {
    if (timer) return;
    firstTimer = setTimeout(run, firstRunDelayMs);
    timer = setInterval(run, intervalMs);
    firstTimer.unref();
    timer.unref();
  }

  function stop() {
    clearTimeout(firstTimer);
    clearInterval(timer);
    firstTimer = null;
    timer = null;
  }

  return { run, start, stop };
}
