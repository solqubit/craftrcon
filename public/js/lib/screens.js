// The console screen of each server (the entries its Console and Dashboard
// show), kept in memory while the panel is open so leaving a page and coming
// back does not lose it, and an answer that lands after leaving still counts.
import { trimToLines } from './console.js';

const screens = new Map(); // serverId -> entries
let nextId = 1;

export const getScreen = (serverId) => screens.get(serverId) ?? [];

// Replaces the screen with trimToLines(change(current)); returns the stored
// entries (the very same array when `change` returned what it was given).
export function updateScreen(serverId, change) {
  const previous = getScreen(serverId);
  const next = trimToLines(change(previous));
  if (next === previous) return previous;
  screens.set(serverId, next);
  return next;
}

// Unique id of a command sent from the UI (links its pending line to its answer).
export const nextSendId = () => nextId++;
