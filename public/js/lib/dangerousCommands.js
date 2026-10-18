// The list of commands that ask for confirmation, shared by every page that
// sends or schedules commands (a hook, kept apart from the pure matcher in
// dangerous.js).
//
//   const { commands, loaded, failed, refresh } = useDangerousCommands();
//
// The list lives in one module-level cache with subscribers: every mounted
// user of the hook sees the same list, and publishDangerousCommands() (called
// by Settings after a save) updates them all at once. Each mount still asks
// the API again, so a list changed from another browser is picked up on the
// next page. Until the API answers (or if it never does) `commands` is the
// last good list, starting from the defaults: better one confirmation too many.
import { useEffect, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';

let snapshot = { commands: [...DEFAULT_DANGEROUS_COMMANDS], loaded: false, failed: false };
const subscribers = new Set();

function publish(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const fn of subscribers) fn(snapshot);
}

// Fetches the list into the cache. Never rejects.
export async function refreshDangerousCommands() {
  try {
    const list = await api('/api/settings/dangerous-commands');
    if (Array.isArray(list) && list.every((c) => typeof c === 'string')) publish({ commands: list, loaded: true, failed: false });
    else publish({ failed: true });
  } catch {
    publish({ failed: true });
  }
}

// Makes `commands` (what the API just saved) the list everyone sees.
export const publishDangerousCommands = (commands) => publish({ commands, loaded: true, failed: false });

export function useDangerousCommands() {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    subscribers.add(setState);
    setState(snapshot); // changes made between render and subscribe
    refreshDangerousCommands();
    return () => subscribers.delete(setState);
  }, []);
  return { ...state, refresh: refreshDangerousCommands };
}
