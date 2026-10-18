// Pure logic of the Players page: the command of each action, the item
// suggestions and the mapping of failures to form fields. No DOM, so it can be
// unit-tested with node:test.
import { ITEMS } from '../data/items.js';
import { ban, deop, give, gamemode, kick, op, tell, tpToCoords, tpToPlayer, whitelistAdd, whitelistRemove } from './builders.js';

// Actions that ask for details first (a dialog) and the ones that run at once.
export const DIALOG_ACTIONS = ['kick', 'ban', 'gamemode', 'teleport', 'give', 'tell'];
export const DIRECT_ACTIONS = ['op', 'deop', 'whitelistAdd', 'whitelistRemove'];

export const MAX_ITEM_SUGGESTIONS = 8;

// The command of `action` for player `name` with the dialog's `values`:
// { reason, mode, tpMode: 'player' | 'coords', target, x, y, z, item, count,
// message }. Throws the builders' error codes for values that can't be sent.
export function buildAction(action, name, values = {}) {
  switch (action) {
    case 'kick':
      return kick(name, values.reason);
    case 'ban':
      return ban(name, values.reason);
    case 'op':
      return op(name);
    case 'deop':
      return deop(name);
    case 'whitelistAdd':
      return whitelistAdd(name);
    case 'whitelistRemove':
      return whitelistRemove(name);
    case 'gamemode':
      return gamemode(name, values.mode);
    case 'teleport':
      return values.tpMode === 'coords'
        ? tpToCoords(name, values.x, values.y, values.z)
        : tpToPlayer(name, values.target);
    case 'give':
      return give(name, values.item, values.count);
    case 'tell':
      return tell(name, values.message);
    default:
      throw new Error('unknown_action');
  }
}

// The form field a builder error belongs to ('form' = none in particular).
export function errorField(code, action) {
  switch (code) {
    case 'invalid_item':
      return 'item';
    case 'invalid_count':
      return 'count';
    case 'invalid_coords':
      return 'coords';
    case 'empty_message':
      return 'message';
    case 'invalid_player':
      return action === 'teleport' ? 'target' : 'form';
    default:
      return 'form';
  }
}

// Item IDs matching what was typed: those that start with it first, then those
// that contain it; "Diamond Sword" and "minecraft:diamond_sword" both work.
export function suggestItems(query, items = ITEMS, limit = MAX_ITEM_SUGGESTIONS) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_');
  if (q === '') return [];
  const starts = [];
  const contains = [];
  for (const item of items) {
    if (item.startsWith(q)) starts.push(item);
    else if (item.includes(q)) contains.push(item);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
