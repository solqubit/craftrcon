import { GAMERULES } from '../../public/js/data/gamerules.js';
import { parseBanlist, parseGamerule, parseList, parseWhitelist } from '../minecraft/parsers.js';
import { notFound, parseId, validation } from './servers.js';

const RANGES = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
const BAN_TYPES = ['players', 'ips'];
// Reads are neither audited nor shown in the console stream.
const READ = { origin: 'ui', audit: false, publish: false };

// All routes are private: the global hook in routes/auth.js guards /api/.
export function registerInfoRoutes(app) {
  // Status cards for the Servers page. The static segment wins over /:id in the router.
  app.get('/api/servers/status', async () => {
    const { servers, status } = app.services;
    const entries = await Promise.all(
      servers.list().map(async ({ id }) => {
        try {
          const { online, players } = await status.get(id);
          return [id, { online, players }];
        } catch {
          return [id, { online: false, players: null }]; // deleted while probing
        }
      }),
    );
    return Object.fromEntries(entries);
  });

  app.get('/api/servers/:id/status', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    try {
      return await app.services.status.get(id);
    } catch (err) {
      if (err?.code === 'NOT_FOUND') return notFound(reply);
      throw err;
    }
  });

  app.get('/api/servers/:id/samples', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    const range = request.query.range ?? '24h';
    if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) return validation(reply, { range: 'invalid' });
    if (!app.services.servers.get(id)) return notFound(reply);
    return app.services.sampler.samples(id, RANGES[range]);
  });

  // Runs one read command. Resolves { output } or { failure: <RconError code> };
  // an unknown server throws NOT_FOUND.
  async function read(id, command) {
    const result = await app.services.commands.run(id, command, READ);
    return result.ok ? { output: result.output } : { failure: result.error };
  }

  // Registers GET /api/servers/:id/<path> answering parse(<RCON output>), where
  // `command` may depend on the request. Validation runs before any RCON call.
  function readRoute(path, command, parse) {
    app.get(`/api/servers/:id/${path}`, async (request, reply) => {
      const id = parseId(request.params.id, reply);
      if (id === null) return;
      const cmd = command(request, reply);
      if (cmd === null) return;
      try {
        const { output, failure } = await read(id, cmd);
        if (failure) return reply.code(502).send({ error: failure });
        return parse(output);
      } catch (err) {
        if (err?.code === 'NOT_FOUND') return notFound(reply);
        throw err;
      }
    });
  }

  readRoute('players', () => 'list', parseList);
  readRoute('whitelist', () => 'whitelist list', parseWhitelist);
  readRoute(
    'bans',
    (request, reply) => {
      const type = request.query.type ?? 'players';
      if (typeof type !== 'string' || !BAN_TYPES.includes(type)) {
        validation(reply, { type: 'invalid' });
        return null;
      }
      return `banlist ${type}`;
    },
    parseBanlist,
  );

  // Current value of every known gamerule: `name` is tried first, then its
  // snake_case `alt`; a rule the server answers for neither is left out.
  app.get('/api/servers/:id/gamerules', async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    try {
      const rules = [];
      // Serial: the RCON connection runs one command at a time anyway.
      for (const { name, alt, type } of GAMERULES) {
        for (const candidate of alt ? [name, alt] : [name]) {
          const { output, failure } = await read(id, `gamerule ${candidate}`);
          if (failure) return reply.code(502).send({ error: failure });
          const parsed = parseGamerule(output);
          if (parsed) {
            rules.push({ name: candidate, type, value: parsed.value });
            break;
          }
        }
      }
      return rules;
    } catch (err) {
      if (err?.code === 'NOT_FOUND') return notFound(reply);
      throw err;
    }
  });
}
