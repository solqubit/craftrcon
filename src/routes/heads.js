import { readFileSync } from 'node:fs';
import { isValidPlayerName } from '../../public/js/lib/names.js';

const FALLBACK_SVG = readFileSync(new URL('../../public/img/head-fallback.svg', import.meta.url));

// Private like every /api/ route: the browser sends its session cookie with
// same-origin <img> requests.
export function registerHeadRoutes(app) {
  app.get('/api/heads/:name', async (request, reply) => {
    const { name } = request.params;
    if (!isValidPlayerName(name)) return reply.code(400).send({ error: 'invalid_name' });
    const head = await app.services.heads.get(name);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (head.type === 'png') {
      return reply.type('image/png').header('Cache-Control', 'max-age=86400').send(head.buffer);
    }
    return reply.type('image/svg+xml').header('Cache-Control', 'max-age=3600').send(FALLBACK_SVG);
  });
}
