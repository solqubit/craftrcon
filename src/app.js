import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuth, PUBLIC } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';

// Builds the Fastify instance without listening. Later tasks register their
// hooks and routes here. `db` may be null and `services` may be {} in tests
// that only touch /api/health.
export function buildApp({ config, db, services }) {
  const app = Fastify({ trustProxy: config.trustProxy });
  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('services', services);

  app.register(cookie);
  registerAuth(app);
  registerServerRoutes(app);

  app.get('/api/health', { config: PUBLIC }, async () => ({ ok: true, version: config.version }));

  return app;
}
