import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { registerAuth, PUBLIC } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerLiveRoutes } from './routes/live.js';
import { registerInfoRoutes } from './routes/info.js';
import { registerHeadRoutes } from './routes/heads.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerSettingsRoutes } from './routes/settings.js';

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
  registerInfoRoutes(app);
  registerHeadRoutes(app);
  registerTaskRoutes(app);
  registerSettingsRoutes(app);

  app.get('/api/health', { config: PUBLIC }, async () => ({ ok: true, version: config.version }));

  registerStatic(app);

  return app;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const LOCALES_DIR = fileURLToPath(new URL('../locales/', import.meta.url));

const HTML_SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// "/%61pi/x" is still an API path; undecodable input is checked as is.
function decodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// The SPA: files from public/ at "/" and translations at "/locales/". Their
// wildcard routes ("/*", "/locales/*") do not start with /api/, so the auth
// hook leaves them public; they expose only the shipped UI. Any other GET that
// does not look like a file gets index.html, so the app can deep-link.
function registerStatic(app) {
  app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  app.register(fastifyStatic, { root: LOCALES_DIR, prefix: '/locales/', decorateReply: false });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) reply.headers(HTML_SECURITY_HEADERS);
    return payload;
  });

  app.setNotFoundHandler((request, reply) => {
    const path = decodePath(request.url.split('?')[0]).toLowerCase();
    const isApi = path === '/api' || path.startsWith('/api/');
    const looksLikeFile = /\.[^/]*$/.test(path);
    if (isApi || looksLikeFile || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
}
