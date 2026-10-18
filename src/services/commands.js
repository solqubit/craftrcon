import { validateCommand } from '../minecraft/validate.js';
import { RconError } from '../minecraft/rcon.js';

export const HISTORY_LIMIT = 200;
export const MAX_LABEL = 40;
const AUDIT_RESULT_CHARS = 500;

// Thrown by run() for a command validateCommand rejects; `reason` is its error code.
export class InvalidCommandError extends Error {
  constructor(reason) {
    super(`Invalid command: ${reason}`);
    this.name = 'InvalidCommandError';
    this.code = 'INVALID_COMMAND';
    this.reason = reason;
  }
}

export function createCommands({ db, manager, audit, hub, now = Date.now }) {
  const insertHistory = db.prepare('INSERT INTO command_history (server_id, command, ts) VALUES (?, ?, ?)');
  const trimHistory = db.prepare(
    `DELETE FROM command_history WHERE server_id = ? AND id NOT IN
       (SELECT id FROM command_history WHERE server_id = ? ORDER BY id DESC LIMIT ?)`,
  );
  const selectHistory = db.prepare(
    'SELECT command, ts FROM command_history WHERE server_id = ? ORDER BY id DESC LIMIT ?',
  );

  // Validates and executes one command. Throws InvalidCommandError (nothing is
  // sent) or an Error with code NOT_FOUND for an unknown server; an RCON
  // failure resolves with { ok: false, error: <RconError code> } instead.
  async function run(serverId, command, { origin, audit: doAudit = true, publish = true } = {}) {
    const checked = validateCommand(command);
    if (!checked.ok) throw new InvalidCommandError(checked.error);
    const cmd = checked.command;

    const connection = manager.get(serverId); // throws NOT_FOUND
    const start = performance.now();
    let result;
    try {
      result = { ok: true, output: await connection.exec(cmd), error: null };
    } catch (err) {
      if (!(err instanceof RconError)) throw err;
      result = { ok: false, output: '', error: err.code };
    }
    const durationMs = Math.round(performance.now() - start);
    const ts = now();

    if (origin === 'console') {
      insertHistory.run(serverId, cmd, ts);
      trimHistory.run(serverId, serverId, HISTORY_LIMIT);
    }
    if (doAudit) {
      audit.log({
        serverId,
        origin,
        action: 'command',
        detail: cmd,
        ok: result.ok,
        result: result.ok ? result.output.slice(0, AUDIT_RESULT_CHARS) : result.error,
      });
    }
    if (publish) {
      hub.publish(serverId, {
        type: 'console',
        entry: { ts, origin, command: cmd, ok: result.ok, output: result.output, error: result.error },
      });
    }
    return { ...result, durationMs, ts };
  }

  // Newest first.
  const history = (serverId) => selectHistory.all(serverId, HISTORY_LIMIT);

  // Favorites: { id, label, command, position }, scoped to one server.
  const favSelect = 'SELECT id, label, command, position FROM favorites';
  const favList = db.prepare(`${favSelect} WHERE server_id = ? ORDER BY position, id`);
  const favGet = db.prepare(`${favSelect} WHERE server_id = ? AND id = ?`);
  const favNextPosition = db.prepare(
    'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM favorites WHERE server_id = ?',
  );
  const favInsert = db.prepare('INSERT INTO favorites (server_id, label, command, position) VALUES (?, ?, ?, ?)');
  const favUpdate = db.prepare(
    'UPDATE favorites SET label = ?, command = ?, position = ? WHERE server_id = ? AND id = ?',
  );
  const favDelete = db.prepare('DELETE FROM favorites WHERE server_id = ? AND id = ?');

  const favorites = {
    list: (serverId) => favList.all(serverId),
    get: (serverId, id) => favGet.get(serverId, id) ?? null,
    // `position` undefined appends after the last one.
    create(serverId, { label, command, position }) {
      const pos = position ?? favNextPosition.get(serverId).next;
      const { lastInsertRowid } = favInsert.run(serverId, label, command, pos);
      return favGet.get(serverId, Number(lastInsertRowid));
    },
    update(serverId, id, { label, command, position }) {
      if (Number(favUpdate.run(label, command, position, serverId, id).changes) === 0) return null;
      return favGet.get(serverId, id);
    },
    remove: (serverId, id) => Number(favDelete.run(serverId, id).changes) > 0,
  };

  return { run, history, favorites };
}
