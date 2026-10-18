import { verifyPassword } from '../security/password.js';
import { createRateLimiter } from '../security/rateLimit.js';

export const SESSION_COOKIE = 'craftrcon_sid';
const COOKIE_MAX_AGE_S = 7 * 24 * 3600;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_PATHS = new Set(['/api/health', '/api/login']);

function firstValue(header) {
  if (typeof header !== 'string') return undefined;
  return header.split(',')[0].trim() || undefined;
}

// Exported so WebSocket routes can reuse the exact same check.
export function originAllowed(request, config) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const expected =
    (config.trustProxy ? firstValue(request.headers['x-forwarded-host']) : undefined) ??
    request.headers.host;
  return typeof expected === 'string' && originHost.toLowerCase() === expected.toLowerCase();
}

// Registers directly on the root instance (not via app.register) so the global
// hook covers every route added later, whatever plugin scope it lives in.
export function registerAuth(app) {
  const { config } = app;
  const limiter = app.services.rateLimiter ?? createRateLimiter();

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: Boolean(config.domain),
  };

  const sidOf = (request) => app.parseCookie(request.headers.cookie ?? '')[SESSION_COOKIE];

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (path === '/api/health') return;

    if (!SAFE_METHODS.has(request.method) && !originAllowed(request, config)) {
      return reply.code(403).send({ error: 'bad_origin' });
    }
    if (PUBLIC_PATHS.has(path)) return;

    if (!app.services.sessions.validate(sidOf(request))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/api/login', async (request, reply) => {
    const { sessions, audit, settings } = app.services;
    const ip = request.ip;

    const gate = limiter.check(ip);
    if (!gate.allowed) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: gate.retryAfterMs });
    }

    const password = request.body?.password;
    const stored = settings.get('admin_password_hash', null);
    const ok = stored !== null && (await verifyPassword(password, stored));

    if (!ok) {
      limiter.fail(ip);
      audit.log({ origin: 'auth', action: 'login_fail', detail: ip, ok: false });
      return reply.code(401).send({ error: 'invalid_password' });
    }

    limiter.success(ip);
    audit.log({ origin: 'auth', action: 'login_ok', detail: ip });
    reply.setCookie(SESSION_COOKIE, sessions.create(), { ...cookieOptions, maxAge: COOKIE_MAX_AGE_S });
    return reply.code(204).send();
  });

  app.post('/api/logout', async (request, reply) => {
    app.services.sessions.destroy(sidOf(request));
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });

  app.get('/api/me', async () => ({ authenticated: true }));
}
