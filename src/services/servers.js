import { encryptSecret, decryptSecret } from '../security/secretbox.js';

export const ICONS = ['mountain', 'sparkle', 'sword', 'castle', 'tree', 'fire', 'diamond', 'skull'];
export const COLORS = ['emerald', 'violet', 'amber', 'sky', 'rose', 'slate'];

export const DEFAULT_RCON_PORT = 25575;
export const DEFAULT_GAME_PORT = 25565;
const DEFAULT_ICON = 'mountain';
const DEFAULT_COLOR = 'emerald';

const MAX_NAME = 32;
export const MAX_HOST = 255;
const MAX_PASSWORD = 512;

const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

// Thrown by create/update when another server already has the name.
export class NameTakenError extends Error {
  constructor() {
    super('Server name already in use');
    this.name = 'NameTakenError';
    this.code = 'NAME_TAKEN';
  }
}

// Returns the trimmed string, or null after recording the error code in `fields`.
export function checkString(fields, field, value, max) {
  if (typeof value !== 'string') {
    fields[field] = 'invalid';
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') fields[field] = 'required';
  else if (trimmed.length > max) fields[field] = 'too_long';
  else return trimmed;
  return null;
}

// Validates and normalises server input. `current` (a public server object) is
// the base for an update: absent fields keep their current value. Without it
// (create) name, host and password are required and the rest get defaults.
// Returns { fields, value }; `fields` is empty when valid, and `value` holds the
// normalised { name, host, rconPort, gamePort, icon, color, password? }.
export function validateServerInput(input, current = null) {
  const body = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = {};
  const value = {};
  const has = (key) => body[key] !== undefined;

  const text = (key, max) => {
    if (!current || has(key)) value[key] = checkString(fields, key, body[key] ?? '', max);
    else value[key] = current[key];
  };
  text('name', MAX_NAME);
  text('host', MAX_HOST);

  const port = (key, fallback) => {
    const v = has(key) ? body[key] : (current?.[key] ?? fallback);
    if (isPort(v)) value[key] = v;
    else fields[key] = 'invalid';
  };
  port('rconPort', DEFAULT_RCON_PORT);
  port('gamePort', DEFAULT_GAME_PORT);

  const choice = (key, allowed, fallback) => {
    const v = has(key) ? body[key] : (current?.[key] ?? fallback);
    if (allowed.includes(v)) value[key] = v;
    else fields[key] = 'invalid';
  };
  choice('icon', ICONS, DEFAULT_ICON);
  choice('color', COLORS, DEFAULT_COLOR);

  // Password: required on create; on update empty or absent means "unchanged".
  const password = checkPassword(fields, body.password);
  if (password !== null) value.password = password;
  else if (!current && !fields.password) fields.password = 'required';

  return { fields, value };
}

// Returns the password, or null when it is absent/empty (no error recorded) or
// invalid (error recorded in `fields`).
export function checkPassword(fields, pw) {
  if (pw === undefined || pw === null || pw === '') return null;
  if (typeof pw !== 'string') fields.password = 'invalid';
  else if (pw.length > MAX_PASSWORD) fields.password = 'too_long';
  else return pw;
  return null;
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    rconPort: row.rcon_port,
    gamePort: row.game_port,
    icon: row.icon,
    color: row.color,
  };
}

function isNameConflict(err) {
  return typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed: servers.name');
}

// Server records. RCON passwords are stored encrypted with `key` and only ever
// leave this module through credentials(), which is for the backend alone.
export function createServers(db, key, { now = Date.now } = {}) {
  const COLUMNS = 'id, name, host, rcon_port, game_port, icon, color';
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM servers ORDER BY id`);
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`);
  const selectCreds = db.prepare('SELECT host, rcon_port, rcon_password_enc FROM servers WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO servers (name, host, rcon_port, rcon_password_enc, game_port, icon, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRow = db.prepare(
    `UPDATE servers SET name = ?, host = ?, rcon_port = ?, game_port = ?, icon = ?, color = ?, updated_at = ?
     WHERE id = ?`,
  );
  const updatePassword = db.prepare('UPDATE servers SET rcon_password_enc = ? WHERE id = ?');
  const deleteRow = db.prepare('DELETE FROM servers WHERE id = ?');

  const list = () => selectAll.all().map(toPublic);

  function get(id) {
    const row = selectOne.get(id);
    return row ? toPublic(row) : null;
  }

  // `input` must already be validated (see validateServerInput).
  function create(input) {
    const ts = now();
    try {
      const { lastInsertRowid } = insert.run(
        input.name,
        input.host,
        input.rconPort,
        encryptSecret(key, input.password),
        input.gamePort,
        input.icon,
        input.color,
        ts,
        ts,
      );
      return get(Number(lastInsertRowid));
    } catch (err) {
      if (isNameConflict(err)) throw new NameTakenError();
      throw err;
    }
  }

  // `input` is a full validated record (current values merged in). A password,
  // when present, replaces the stored one. Returns null for an unknown id.
  function update(id, input) {
    db.exec('BEGIN');
    try {
      const result = updateRow.run(
        input.name,
        input.host,
        input.rconPort,
        input.gamePort,
        input.icon,
        input.color,
        now(),
        id,
      );
      if (Number(result.changes) === 0) {
        db.exec('ROLLBACK');
        return null;
      }
      if (input.password) updatePassword.run(encryptSecret(key, input.password), id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (isNameConflict(err)) throw new NameTakenError();
      throw err;
    }
    return get(id);
  }

  // Deletes the server and, by cascade, everything that belongs to it.
  const remove = (id) => Number(deleteRow.run(id).changes) > 0;

  function credentials(id) {
    const row = selectCreds.get(id);
    if (!row) return null;
    return { host: row.host, rcon_port: row.rcon_port, password: decryptSecret(key, row.rcon_password_enc) };
  }

  return { list, get, create, update, remove, credentials };
}
