// Parsers for the text vanilla/Paper servers answer over RCON (Java 1.16+).
// Every parser strips color codes first and returns { raw } (or null for the
// numeric ones) when it does not recognize the text, so the UI can show it as is.
// `raw` keeps the original, unstripped text so the UI can still render colors.
import { stripCodes } from '../../public/js/lib/mctext.js';
import { isValidPlayerName } from '../../public/js/lib/names.js';

// Server responses only use '§'; a '&' there is real text (e.g. in a ban reason).
const clean = (t) => stripCodes(String(t ?? ''), { ampersand: false });

// Player lists. Supported decorations, per line / per name:
//  - a group prefix at the start of a line matching /^\w+:\s/ ("default: Steve, Alex");
//  - a bracketed rank prefix before a name ("[Admin] Steve").
// Names are not validated: Floodgate/Bedrock names may contain dots or spaces.
function splitPlayers(text) {
  const players = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.replace(/^\s*\w+:\s+/, '').split(',')) {
      const name = part.trim().replace(/^(?:\[[^\]]*\]\s*)+/, '');
      if (name) players.push(name);
    }
  }
  return players;
}

const LIST_RE = /^\s*There are (\d+)(?: of a max of |\/)(\d+) players online:([\s\S]*)$/i;

export function parseList(t) {
  const m = LIST_RE.exec(clean(t));
  if (!m) return { raw: t };
  return { online: Number(m[1]), max: Number(m[2]), players: splitPlayers(m[3]) };
}

const BAN_HEADER_RE = /^\s*There are \d+ ban\(s\):\s*/i;
const BAN_MARK = ' was banned by ';
const IPV4_TAIL_RE = /(\d{1,3}(?:\.\d{1,3}){3})$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const isBanTarget = (s) => isValidPlayerName(s) || IPV4_RE.test(s);

// Vanilla RCON joins the banlist lines with NO separator:
//   "Steve was banned by Server: GriefingAlex was banned by Dami: Spam"
// so the target of entry N+1 sits glued to the end of the reason of entry N.
// Everything is anchored on the literal " was banned by " and the
// "TARGET was banned by SOURCE: REASON" structure (reasons may contain colons).
//
// Residual ambiguity: where a reason ends and the next name begins cannot be
// recovered in general ("GriefingAlex" could be reason "GriefingAlex" +
// name "x"). Heuristics for the trailing alphanumeric run of the text before
// a marker, in order:
//  1. a newline in the text: the last line is the target (clean separation);
//  2. an IPv4 address at the end is the target;
//  3. a run preceded by sentence punctuation ". ! ? ) ]" (vanilla's default
//     "Banned by an operator." ends in one) is the whole name;
//  4. otherwise the name starts at the first lower-to-upper case transition
//     ("GriefingAlex" -> "Alex", "Using hacksAlex" -> "Alex"), or is the whole
//     run when there is none.
// A reason ending in a name-like word, or CamelCase names glued to a reason
// without punctuation, can therefore be split wrongly. Only IPv4 bans are
// recognized (not IPv6, whose colons clash with the SOURCE: separator).
function splitTrailingTarget(text) {
  const nl = text.lastIndexOf('\n');
  if (nl >= 0) return { reason: text.slice(0, nl), target: text.slice(nl + 1).trim() };

  const ip = IPV4_TAIL_RE.exec(text);
  if (ip) return { reason: text.slice(0, ip.index), target: ip[1] };

  const tail = /[A-Za-z0-9_]+$/.exec(text);
  if (!tail) return null;
  let start = tail.index;
  let run = tail[0];
  if (run.length > 16) {
    start += run.length - 16;
    run = run.slice(-16);
  }
  const prev = start > 0 ? text[start - 1] : '';
  if (run.length === tail[0].length && /[.!?)\]]/.test(prev)) {
    return { reason: text.slice(0, start), target: run };
  }
  for (let i = 1; i < run.length; i++) {
    if (/[a-z0-9]/.test(run[i - 1]) && /[A-Z]/.test(run[i])) {
      start += i;
      run = run.slice(i);
      break;
    }
  }
  return { reason: text.slice(0, start), target: run };
}

export function parseBanlist(t) {
  const text = clean(t);
  if (/^\s*There are no bans\s*$/i.test(text)) return { entries: [] };
  const body = text.replace(BAN_HEADER_RE, '');

  const marks = [];
  for (let at = body.indexOf(BAN_MARK); at >= 0; at = body.indexOf(BAN_MARK, at + BAN_MARK.length)) marks.push(at);
  if (marks.length === 0) return BAN_HEADER_RE.test(text) && body.trim() === '' ? { entries: [] } : { raw: t };

  let target = body.slice(0, marks[0]).trim();
  const entries = [];
  for (let k = 0; k < marks.length; k++) {
    if (!isBanTarget(target)) return { raw: t };
    const chunk = body.slice(marks[k] + BAN_MARK.length, k + 1 < marks.length ? marks[k + 1] : body.length);
    const src = /^([^:\n]*):[ \t]?/.exec(chunk);
    if (!src) return { raw: t };
    let reason = chunk.slice(src[0].length);
    if (k + 1 < marks.length) {
      const next = splitTrailingTarget(reason);
      if (!next) return { raw: t };
      reason = next.reason;
      entries.push({ target, source: src[1].trim(), reason: reason.trim() });
      target = next.target;
    } else {
      entries.push({ target, source: src[1].trim(), reason: reason.trim() });
    }
  }
  return { entries };
}

export function parseWhitelist(t) {
  const text = clean(t);
  if (/^\s*There are no whitelisted players\s*$/i.test(text)) return { players: [] };
  const m = /^\s*There are \d+ whitelisted players?(?:\(s\)|s)?:([\s\S]*)$/i.exec(text);
  if (!m) return { raw: t };
  return { players: splitPlayers(m[1]) };
}

// "TPS from last 1m, 5m, 15m: 20.0, *20.0, 19.97" ('*' marks an estimate).
// Purpur prints four values ("5s, 1m, 5m, 15m"): the last three are always 1m, 5m, 15m.
export function parseTps(t) {
  const m = /TPS from last[^:]*:([\s\S]*)$/i.exec(clean(t));
  if (!m) return null;
  const nums = m[1].replace(/\*/g, '').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) return null;
  return nums.slice(-3).map(Number);
}

// "Gamerule keepInventory is currently set to: false". The "is now set to"
// wording (answer to a change) is accepted as well.
export function parseGamerule(t) {
  const m = /Gamerule (\S+) is (?:currently|now) set to:\s*(.*?)\s*$/i.exec(clean(t));
  return m ? { name: m[1], value: m[2] } : null;
}
