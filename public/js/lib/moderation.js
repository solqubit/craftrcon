// Pure logic of the Moderation page: which tab the URL selects, keyboard
// movement along the tab list, and the client-side filter of the long lists.
// No DOM, so it can be unit-tested with node:test.

export const MODERATION_TABS = ['bans', 'ips', 'whitelist', 'ops'];
export const DEFAULT_TAB = MODERATION_TABS[0];

// The tab a location hash selects: "#/moderation?tab=ips" -> 'ips'. Anything
// unknown (or no query at all) falls back to the first tab.
export function tabFromHash(hash) {
  const query = String(hash ?? '').split('?')[1] ?? '';
  const tab = new URLSearchParams(query).get('tab');
  return MODERATION_TABS.includes(tab) ? tab : DEFAULT_TAB;
}

// The hash that selects `tab`; the default tab keeps the plain route.
export const tabHash = (tab) => (tab === DEFAULT_TAB || !MODERATION_TABS.includes(tab) ? '#/moderation' : `#/moderation?tab=${tab}`);

// The tab an arrow/Home/End key moves to from `current`, or null for any other
// key. Left and right wrap around, as the ARIA tabs pattern asks.
export function tabForKey(key, current) {
  const last = MODERATION_TABS.length - 1;
  const index = MODERATION_TABS.indexOf(current);
  if (index < 0) return null;
  if (key === 'ArrowRight') return MODERATION_TABS[index === last ? 0 : index + 1];
  if (key === 'ArrowLeft') return MODERATION_TABS[index === 0 ? last : index - 1];
  if (key === 'Home') return MODERATION_TABS[0];
  if (key === 'End') return MODERATION_TABS[last];
  return null;
}

const norm = (value) => String(value ?? '').toLowerCase();

// The entries ({ target, source, reason }) with `query` (case-insensitive,
// trimmed) in the target, the source or the reason. An empty query keeps all.
export function filterBans(entries, query) {
  const q = norm(query).trim();
  if (q === '') return entries;
  return entries.filter((e) => [e.target, e.source, e.reason].some((field) => norm(field).includes(q)));
}

// The names that contain `query` (case-insensitive, trimmed).
export function filterNames(names, query) {
  const q = norm(query).trim();
  if (q === '') return names;
  return names.filter((name) => norm(name).includes(q));
}

// How a /bans or /whitelist answer is shown: the entries, the unparsed text
// ({ raw }), or nothing usable (an answer of an unexpected shape).
export function listView(data, key) {
  if (data && typeof data.raw === 'string') return { kind: 'raw', raw: data.raw };
  if (data && Array.isArray(data[key])) return { kind: 'list', items: data[key] };
  return { kind: 'unknown' };
}
