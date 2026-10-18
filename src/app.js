import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { registerAuth, PUBLIC } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerLiveRoutes } from './routes/live.js';

// Builds the Fastify instance without listening. Later tasks register their
// hooks and routes here. `db` may be null and `services` may be {} in tests
// that only touch /api/health.
export function buildApp({ config, db, services }) {
  const app = Fastify({ trustProxy: config.trustProxy });
  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('services', services);

  app.register(cookie);
  app.register(websocket);
  registerAuth(app);
  registerServerRoutes(app);
  registerConsoleRoutes(app);
  registerLiveRoutes(app);

  app.get('/api/health', { config: PUBLIC }, async () => ({ ok: true, version: config.version }));

  return app;
}
