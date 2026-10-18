import { notFound, parseId, validation } from './servers.js';

const RANGES = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

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
}
