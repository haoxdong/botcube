import { Hono } from 'hono';
import { verifyCredentialServiceInvocation } from './credential-service-token.js';

export const TOKEN_INTROSPECTION_PATH = '/oauth/introspect';
export const TOKEN_INTROSPECTION_SCOPE = 'token_introspection';

export interface IntrospectedSessions {
  /** The live session a token names, extended by the check; null when it is not live. */
  liveSession(token: string): Promise<{ account: { accountId: string }; expiresAt: number } | null>;
}

/** OAuth 2.0 Token Introspection (RFC 7662) of the Chat Service's session tokens, for invocations the secret signs. */
export function tokenIntrospectionRoutes({ sessions, invocationSecret }: { sessions: () => IntrospectedSessions; invocationSecret: string }): Hono {
  const app = new Hono();
  app.post(TOKEN_INTROSPECTION_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const caller = /^Bearer (\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const invocation = caller === undefined ? null : verifyCredentialServiceInvocation(invocationSecret, caller);
    if (invocation?.scope !== TOKEN_INTROSPECTION_SCOPE) {
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json({ error: 'invalid_client' }, 401);
    }
    const token = (await c.req.parseBody().catch(() => null))?.token;
    if (typeof token !== 'string' || !token) return c.json({ error: 'invalid_request' }, 400);
    const live = await sessions().liveSession(token);
    return c.json(live === null ? { active: false } : { active: true, sub: live.account.accountId, exp: live.expiresAt });
  });
  return app;
}
