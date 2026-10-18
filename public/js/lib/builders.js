// Builders of the commands the Players page sends. Pure functions that return
// the command as one string and throw an Error whose message is a code when an
// argument can't be sent safely:
//   invalid_player, invalid_ip, invalid_mode, invalid_coords, invalid_item,
//   invalid_count, empty_message.
// Free text (reasons, messages) goes through oneLine, so a pasted line break
// can't turn into a second command.
import { isValidPlayerName, oneLine } from './names.js';

export const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];
export const MAX_GIVE_COUNT = 6400;

const ITEM_ID = /^[a-z0-9_:.]+$/;
// 12, -3.5, ~, ~2, ~-1.5, ^, ^4 (local coordinates).
const COORDINATE = /^(?:-?\d+(?:\.\d+)?|[~^](?:-?\d+(?:\.\d+)?)?)$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
// Typed as an address (digits, hex letters, dots, colons), valid or not.
const IP_LIKE = /^(?=.*[.:])[0-9a-f:.]+$/i;

function fail(code) {
  throw new Error(code);
}

function player(name) {
  if (!isValidPlayerName(name)) fail('invalid_player');
  return name;
}

function isIpv6(text) {
  if (!/^[0-9a-f:]+$/i.test(text)) return false;
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === '' ? [] : half.split(':')));
  if (!groups.every((group) => HEX_GROUP.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

const isIp = (text) => typeof text === 'string' && (IPV4.test(text) || isIpv6(text));

function ip(text) {
  if (!isIp(text)) fail('invalid_ip');
  return text;
}

// " reason" for a non-empty reason, "" otherwise.
function reasonPart(reason) {
  const text = oneLine(reason).trim();
  return text === '' ? '' : ` ${text}`;
}

function coordinate(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!COORDINATE.test(text)) fail('invalid_coords');
  return text;
}

export const kick = (p, reason) => `kick ${player(p)}${reasonPart(reason)}`;
export const ban = (p, reason) => `ban ${player(p)}${reasonPart(reason)}`;

// `target` is an IP address, or the name of an online player (the server bans
// the IP that player is connected from). Whatever looks like an address must
// be a valid one.
export function banIp(target, reason) {
  const text = typeof target === 'string' && IP_LIKE.test(target) ? ip(target) : player(target);
  return `ban-ip ${text}${reasonPart(reason)}`;
}

export const pardon = (p) => `pardon ${player(p)}`;
export const pardonIp = (address) => `pardon-ip ${ip(address)}`;
export const op = (p) => `op ${player(p)}`;
export const deop = (p) => `deop ${player(p)}`;

export function gamemode(p, mode) {
  const name = player(p);
  if (!GAME_MODES.includes(mode)) fail('invalid_mode');
  return `gamemode ${mode} ${name}`;
}

export const tpToPlayer = (p, target) => `tp ${player(p)} ${player(target)}`;

// x, y, z: numbers or strings such as "~", "~5", "^-2". Local (^) and world
// coordinates can't be mixed, as the game itself requires.
export function tpToCoords(p, x, y, z) {
  const name = player(p);
  const coords = [x, y, z].map(coordinate);
  const local = coords.filter((c) => c.startsWith('^')).length;
  if (local !== 0 && local !== 3) fail('invalid_coords');
  return `tp ${name} ${coords.join(' ')}`;
}

export function give(p, item, count) {
  const name = player(p);
  if (typeof item !== 'string' || !ITEM_ID.test(item)) fail('invalid_item');
  const n = typeof count === 'number' ? count : typeof count === 'string' && /^\d+$/.test(count.trim()) ? Number(count) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_GIVE_COUNT) fail('invalid_count');
  return `give ${name} ${item} ${n}`;
}

export function tell(p, message) {
  const name = player(p);
  const text = oneLine(message).trim();
  if (text === '') fail('empty_message');
  return `tell ${name} ${text}`;
}

export const whitelistAdd = (p) => `whitelist add ${player(p)}`;
export const whitelistRemove = (p) => `whitelist remove ${player(p)}`;
export const whitelistToggle = (on) => (on ? 'whitelist on' : 'whitelist off');
