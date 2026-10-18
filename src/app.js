import Fastify from 'fastify';

// Builds the Fastify instance without listening. Later tasks register their
// hooks and routes here. `db` may be null and `services` may be {} in tests.
export function buildApp({ config, db, services }) {
  const app = Fastify({ trustProxy: config.trustProxy });
  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('services', services);

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  return app;
}
