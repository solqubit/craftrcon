// Global UI state: { authenticated, servers, activeServerId, lang }.
//  - authenticated: null while the session is being checked, then true/false.
//  - servers: null until loaded, then the array from GET /api/servers.
//  - activeServerId: the server every section works on (remembered locally).
import { useEffect, useState } from '../vendor/htm-preact.js';

const SERVER_KEY = 'craftrcon.server';

function readStoredServer() {
  try {
    const id = Number(localStorage.getItem(SERVER_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function storeServer(id) {
  try {
    if (id === null) localStorage.removeItem(SERVER_KEY);
    else localStorage.setItem(SERVER_KEY, String(id));
  } catch {
    // Storage unavailable: the choice lasts until the page reloads.
  }
}

let state = { authenticated: null, servers: null, activeServerId: readStoredServer(), lang: 'en' };
const listeners = new Set();

export const store = {
  get: () => state,
  set(patch) {
    state = { ...state, ...patch };
    if ('activeServerId' in patch) storeServer(state.activeServerId);
    for (const fn of listeners) fn(state);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Stores a fresh server list and keeps the active server valid: it stays if it
// still exists, otherwise the first server (or none) becomes active.
export function setServers(servers) {
  const { activeServerId } = state;
  const keep = servers.some((s) => s.id === activeServerId);
  store.set({ servers, activeServerId: keep ? activeServerId : (servers[0]?.id ?? null) });
}

export const activeServer = (s = state) => s.servers?.find((srv) => srv.id === s.activeServerId) ?? null;

// Re-renders the calling component on every store change.
export function useStore() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    setSnapshot(state); // catch changes made between render and subscribe
    return store.subscribe(setSnapshot);
  }, []);
  return snapshot;
}
