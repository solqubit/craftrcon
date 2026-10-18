// Pure helpers of the Dashboard page. No DOM, so they can be unit-tested.

export const MINI_CONSOLE_LINES = 6;

// TPS tile color: >= 18 healthy, >= 15 degraded, below that critical.
export function tpsLevel(tps) {
  if (typeof tps !== 'number' || !Number.isFinite(tps)) return null;
  if (tps >= 18) return 'good';
  if (tps >= 15) return 'warn';
  return 'bad';
}

// One decimal; the game never runs above 20 ticks per second, so a value a
// hair over it (a rounding quirk of some servers) shows as 20.0.
export const tpsText = (tps) => Math.min(20, tps).toFixed(1);

// "Paper 1.21.4" already names its software; a bare "1.21.4" gets it prepended.
export function versionLabel(version, software) {
  const v = typeof version === 'string' ? version.trim() : '';
  const s = typeof software === 'string' ? software.trim() : '';
  if (!s) return v;
  if (!v) return s;
  return v.toLowerCase().includes(s.toLowerCase()) ? v : `${s} ${v}`;
}

// Translation key for the error of an offline status (a Server List Ping code).
const PING_ERRORS = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'TIMEOUT', 'PROTOCOL'];
export const offlineErrorKey = (code) => `dashboard.offline.error.${PING_ERRORS.includes(code) ? code : 'PROTOCOL'}`;

// The last `n` items (the same array when it already fits).
export const tail = (list, n) => (list.length > n ? list.slice(-n) : list);

// GET /players answer -> { kind: 'list', names } | { kind: 'raw', raw } | null.
export function playersView(result) {
  if (result === null || typeof result !== 'object') return null;
  if (Array.isArray(result.players)) return { kind: 'list', names: result.players };
  if (typeof result.raw === 'string') return { kind: 'raw', raw: result.raw };
  return null;
}
