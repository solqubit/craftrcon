// Console autocompletion. Pure ES module (no DOM), unit-tested with node:test.
//
// A suggestion is { insert, label, detail }:
//  - insert: the word that replaces the one being typed (see applySuggestion);
//  - label:  what the list shows (a command's full syntax, or the word itself);
//  - detail: a translation key describing it, or null.
import { COMMANDS } from '../data/commands.js';
import { GAMERULES } from '../data/gamerules.js';

export const MAX_SUGGESTIONS = 8;
export const SELECTORS = ['@a', '@p', '@r', '@s', '@e'];

// Syntax arguments that take a player name or a target selector.
const PLAYER_ARGS = new Set(['player', 'target', 'targets', 'destination']);

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];
// Fixed values of other syntax arguments, by argument name.
const VALUES = {
  mode: GAME_MODES,
  gamemode: GAME_MODES,
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  time: ['day', 'night', 'noon', 'midnight'],
};

// "<mode>" -> { name: 'mode' }; "(a|b)" or "[a|b]" -> { choices: ['a', 'b'] }.
function parseArg(token) {
  const inner = token.replace(/^[<[(]/, '').replace(/[>\])]$/, '');
  return inner.includes('|') ? { choices: inner.split('|') } : { name: inner };
}

// "  /gamemode  cr" -> ['gamemode', 'cr']; a trailing space starts a new, empty word.
function words(input) {
  let text = String(input ?? '').replace(/^\s+/, '');
  if (text.startsWith('/')) text = text.slice(1);
  return text.split(/\s+/);
}

const startsWith = (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase());
const findCommand = (commands, name) => commands.find((c) => c.name === name.toLowerCase()) ?? null;

// The word being typed: what a suggestion replaces.
export function lastToken(input) {
  const parts = words(input);
  return parts[parts.length - 1];
}

function commandSuggestions(token, commands) {
  if (token === '') return [];
  const lower = token.toLowerCase();
  const matches = commands.filter((c) => startsWith(c.name, token));
  // An exact name first ("tp" before "tps"), the rest in list order.
  matches.sort((a, b) => (b.name === lower) - (a.name === lower));
  return matches
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => ({ insert: c.name, label: c.syntax, detail: c.descKey }));
}

const plain = (values, detail = () => null) => values.map((v) => ({ insert: v, label: v, detail: detail(v) }));

// Gamerules by their camelCase name; the snake_case name of newer versions is
// offered only when that is what is being typed ("keep_").
function gameruleNames(token) {
  const out = [];
  for (const { name, alt } of GAMERULES) {
    if (startsWith(name, token)) out.push(name);
    else if (alt && startsWith(alt, token)) out.push(alt);
  }
  return out;
}

function argumentSuggestions(arg, token, players) {
  if (arg.choices) return plain(arg.choices.filter((c) => startsWith(c, token)));
  if (PLAYER_ARGS.has(arg.name)) {
    const names = players.filter((p) => typeof p === 'string' && startsWith(p, token)).slice(0, MAX_SUGGESTIONS);
    const selectors = SELECTORS.filter((s) => startsWith(s, token));
    return [
      ...plain(names, () => 'console.suggest.player'),
      ...plain(selectors, (s) => `console.suggest.selector.${s.slice(1)}`),
    ];
  }
  if (arg.name === 'rule') return plain(gameruleNames(token).slice(0, MAX_SUGGESTIONS));
  const values = VALUES[arg.name];
  return values ? plain(values.filter((v) => startsWith(v, token))) : [];
}

// Suggestions for the word at the end of `input`:
//  - the first word: commands whose name starts with it (at most 8);
//  - later words: values for the matching argument of the command's syntax.
export function suggest(input, { commands = COMMANDS, players = [] } = {}) {
  const parts = words(input);
  const token = parts[parts.length - 1];
  if (parts.length === 1) return commandSuggestions(token, commands);
  const command = findCommand(commands, parts[0]);
  if (!command) return [];
  const args = command.syntax.split(' ').slice(1);
  const index = parts.length - 2;
  if (index >= args.length) return [];
  return argumentSuggestions(parseArg(args[index]), token, players);
}

// The input after accepting `suggestion`: the word being typed is replaced
// (a leading '/' is kept) and a space is added, ready for the next argument.
export function applySuggestion(input, suggestion) {
  const text = String(input ?? '');
  const match = /^(.*\s)?(\S*)$/s.exec(text);
  const head = match[1] ?? '';
  const slash = head.trim() === '' && match[2].startsWith('/') ? '/' : '';
  return `${head}${slash}${suggestion.insert} `;
}

// Syntax help for a known command once its name is followed by a space:
// { name, descKey, args, active } where `active` is the index of the argument
// being typed (free text keeps the last one active; -1 when there are none).
export function signature(input, commands = COMMANDS) {
  const parts = words(input);
  if (parts.length < 2) return null;
  const command = findCommand(commands, parts[0]);
  if (!command) return null;
  const args = command.syntax.split(' ').slice(1);
  return {
    name: command.name,
    descKey: command.descKey,
    args,
    active: Math.min(parts.length - 2, args.length - 1),
  };
}
