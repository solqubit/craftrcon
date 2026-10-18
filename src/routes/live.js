import { originAllowed, sidOf } from './auth.js';
import { notFound, parseId } from './servers.js';

// The upgrade request is a GET, so the global hook in routes/auth.js checks the
// session but not the Origin: do it here, before the socket is upgraded, so a
// page on another site cannot read the live stream (WebSocket hijacking).
export function registerLiveRoutes(app) {
  async function preValidation(request, reply) {
    if (!originAllowed(request, app.config)) return reply.code(403).send({ error: 'bad_origin' });
    const id = parseId(request.params.id, reply);
    if (id === null) return;
    if (!app.services.servers.get(id)) return notFound(reply);
  }

  // In its own plugin so it loads after @fastify/websocket: that plugin
  // rewrites websocket routes through an onRoute hook, which only sees routes
  // added once it has loaded.
  app.register(async (scope) => {
    scope.get('/api/servers/:id/live', { websocket: true, preValidation }, (socket, request) => {
      const { hub } = app.services;
      hub.subscribe(Number(request.params.id), socket, app.services.sessions.keyOf(sidOf(app, request)));
      socket.on('close', () => hub.unsubscribe(socket));
    });
  });
}
