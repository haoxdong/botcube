import type { MiddlewareHandler } from 'hono';

const ALLOW_METHODS = 'DELETE, GET, PATCH, POST, PUT, OPTIONS';

/** The BotCube web UI's local development server (`pnpm dev:bot`). */
export const LOCAL_UI_ORIGINS = ['http://localhost:3001', 'http://127.0.0.1:3001'];

/**
 * Credentialed CORS for the given origins: a preflight is 200 for an allowed
 * origin and 400 otherwise, and it allows whatever request headers the preflight asks for.
 */
export function cors(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return async (c, next) => {
    const origin = c.req.header('origin');
    const requestedMethod = c.req.header('access-control-request-method');
    if (c.req.method === 'OPTIONS' && origin !== undefined && requestedMethod !== undefined) {
      const headers = new Headers({ vary: 'Origin', 'access-control-max-age': '600' });
      headers.set('access-control-allow-methods', ALLOW_METHODS);
      const requestedHeaders = c.req.header('access-control-request-headers');
      if (requestedHeaders !== undefined) headers.set('access-control-allow-headers', requestedHeaders);
      if (!allowed.has(origin)) {
        return new Response('Disallowed CORS origin', { status: 400, headers });
      }
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-credentials', 'true');
      return new Response('OK', { status: 200, headers });
    }
    await next();
    if (origin !== undefined && allowed.has(origin)) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('access-control-allow-credentials', 'true');
      c.res.headers.append('vary', 'Origin');
    }
    return undefined;
  };
}
