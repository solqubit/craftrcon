import { RconClient, RconError } from '../minecraft/rcon.js';
import {
  DEFAULT_RCON_PORT,
  MAX_HOST,
  NameTakenError,
  checkPassword,
  checkString,
  validateServerInput,
} from '../services/servers.js';

const TEST_TIMEOUT_MS = 5000;
const POSITIVE_INT = /^[1-9]\d{0,14}$/;

export const validation = (reply, fields) => reply.code(400).send({ error: 'validation', fields });
export const notFound = (reply) => reply.code(404).send({ error: 'not_found' });

// Parses a route id; sends the error response itself and returns null if bad.
export function parseId(raw, reply) {
  if (!POSITIVE_INT.test(raw)) {
    validation(reply, { id: 'invalid' });
    return null;
  }
  return Number(raw);
}

// Connection test with a throwaway client, never the shared manager: the
// values under test may differ from the saved ones.
async function probe({ host, port, password }, log) {
  const client = new RconClient({ host, port, password, timeoutMs: TEST_TIMEOUT_MS });
  try {
    await client.connect();
    const start = performance.now();
    await client.exec('list');
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    if (err instanceof RconError) return { ok: false, error: err.code };
    log.error({ err }, 'unexpected error during server connection test');
    return { ok: false, error: 'CLOSED' };
  } finally {
    client.close();
  }
}

// All routes are private: the global hook in routes/auth.js guards /api/.
export function registerServerRoutes(app) {
  const svc = () => app.services.servers;

  app.get('/api/servers', async () => svc().list());

  // The static segment wins over /:id in the router.
  app.post('/api/servers/test', async (request, reply) => {
    const body = request.body !== null && typeof request.body === 'object' ? request.body : {};
    const fields = {};

    let id = null;
    if (body.id !== undefined && body.id !== null) {
      if (Number.isSafeInteger(body.id) && body.id > 0) id = body.id;
      else fields.id = 'invalid';
    }
    const host = checkString(fields, 'host', body.host ?? '', MAX_HOST);
    const port = body.rconPort ?? DEFAULT_RCON_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fields.rconPort = 'invalid';
    const password = checkPassword(fields, body.password);
    if (Object.keys(fields).length > 0) return validation(reply, fields);

    if (id !== null && !svc().get(id)) return notFound(reply);
    if (password === null) {
      const stored = id === null ? null : svc().credentials(id);
      // The saved password is only ever sent to the saved address: otherwise
      // this route would hand it to whatever host the caller names.
      const sameTarget =
        stored && stored.host.toLowerCase() === host.toLowerCase() && stored.rcon_port === port;
      if (!sameTarget) return validation(reply, { password: 'required' });
      // Connect to the saved address itself, not to the submitted spelling of it.
      return probe({ host: stored.host, port: stored.rcon_port, password: stored.password }, request.log);
    }

    return probe({ host, port, password }, request.log);
  });

  app.post('/api/servers', async (request, reply) => {
    const { fields, value } = validateServerInput(request.body);
    if (Object.keys(fields).length > 0) return validation(reply, fields);
    let server;
    try {
      server = svc().create(value);
    } catch (err) {
      if (err instanceof NameTakenError) return reply.code(409).send({ error: 'name_taken' });
      throw err;
    }
    app.services.audit.log({ serverId: server.id, origin: 'ui', action: 'server_create', detail: server.name });
    return reply.code(201).send(server);
  });

  app.get('/api/servers/:id', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    return svc().get(id) ?? notFound(reply);
  });

  app.put('/api/servers/:id', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const current = svc().get(id);
    if (!current) return notFound(reply);
    const { fields, value } = validateServerInput(request.body, current);
    if (Object.keys(fields).length > 0) return validation(reply, fields);
    let server;
    try {
      server = svc().update(id, value);
    } catch (err) {
      if (err instanceof NameTakenError) return reply.code(409).send({ error: 'name_taken' });
      throw err;
    }
    if (!server) return notFound(reply);
    app.services.manager.invalidate(id);
    app.services.audit.log({ serverId: id, origin: 'ui', action: 'server_update', detail: server.name });
    return server;
  });

  app.delete('/api/servers/:id', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const current = svc().get(id);
    if (!current || !svc().remove(id)) return notFound(reply);
    app.services.manager.invalidate(id);
    // Logged after the delete, with no server_id: the row would cascade away otherwise.
    app.services.audit.log({ origin: 'ui', action: 'server_delete', detail: current.name });
    return reply.code(204).send();
  });
}
