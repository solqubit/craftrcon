import { verifyPassword } from '../security/password.js';
import { createRateLimiter } from '../security/rateLimit.js';

export const SESSION_COOKIE = 'craftrcon_sid';
const COOKIE_MAX_AGE_S = 7 * 24 * 3600;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Routes opt out of the session check with `config: PUBLIC`.
export const PUBLIC = Object.freeze({ public: true });

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

  // Decides on the matched route pattern, never on the raw URL: the router
  // percent-decodes paths, so "/%61pi/me" reaches the "/api/me" handler.
  // Everything under /api/ is private unless the route sets `config: PUBLIC`.
  // Unmatched URLs (404) have no route pattern and expose nothing.
  app.addHook('onRequest', async (request, reply) => {
    const pattern = request.routeOptions.url;
    if (typeof pattern !== 'string' || !pattern.startsWith('/api/')) return;

    if (!SAFE_METHODS.has(request.method) && !originAllowed(request, config)) {
      return reply.code(403).send({ error: 'bad_origin' });
    }
    if (request.routeOptions.config?.public === true) return;

    if (!app.services.sessions.validate(sidOf(request))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/api/login', { config: PUBLIC }, async (request, reply) => {
    const { sessions, audit, settings } = app.services;
    const ip = request.ip;

    const gate = limiter.check(ip);
    if (!gate.allowed) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: gate.retryAfterMs });
    }

    // check() reserved an attempt slot; every path below must settle it.
    let ok;
    try {
      const stored = settings.get('admin_password_hash', null);
      ok = stored !== null && (await verifyPassword(request.body?.password, stored));
    } catch (err) {
      limiter.release(ip);
      throw err;
    }

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
