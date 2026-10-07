import { createHmac, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { accountsNeedingSignIn, templateRequester } from './account.js';

export function invocationToken(secret: string, account: string, session: string, scope?: string): string {
  if (!secret.trim() || !account.trim() || !session.trim()) throw new Error('Template Credential Service signing configuration is required');
  const body = { account_id: account, expires_at: Math.floor(Date.now() / 1000) + 600, ...(scope ? { scope } : {}), session_id: session };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export interface SiteSignInOptions {
  serviceUrl: () => string;
  secret: () => string;
  fetchImpl?: typeof fetch;
}

export function siteSignInRoutes(options: SiteSignInOptions): Hono {
  const pending = new Map<string, { owner: string; expires: number; signedIn: boolean }>();
  const fetchImpl = options.fetchImpl ?? fetch;
  async function call(account: string, path: string, method: string, scope?: string): Promise<{ status: string }> {
    const url = options.serviceUrl();
    if (!url) throw new Error('Template Credential Service URL is required');
    const response = await fetchImpl(`${url}/fake-site/${path}`, {
      method,
      headers: { Authorization: `Bearer ${invocationToken(options.secret(), account, 'template-link', scope)}` },
    });
    if (!response.ok) throw new Error(`Template Credential Service HTTP ${response.status}`);
    const body = await response.json() as { status: string };
    if (typeof body.status !== 'string') throw new Error('Template Credential Service returned malformed link state');
    return body;
  }
  const routes = new Hono();
  routes.get('/account/session', async (c) => {
    const { owner } = await templateRequester(c);
    return c.json({ status: 'ready', accountId: owner, signInNeeded: accountsNeedingSignIn.has(owner) });
  });
  routes.get('/account/sign-ins', async (c) => {
    const { owner } = await templateRequester(c);
    const state = await call(owner, 'auth/status', 'GET');
    return c.json({ signIns: [{ provider: 'fake-site', name: 'Template site', status: state.status }] });
  });
  routes.post('/account/fake-site-link/start', async (c) => {
    const { owner } = await templateRequester(c);
    const now = Date.now();
    for (const [id, link] of pending) if (link.expires <= now) pending.delete(id);
    const linkId = randomUUID();
    pending.set(linkId, { owner, expires: now + 300_000, signedIn: false });
    return c.json({ linkId });
  });
  for (const action of ['sign-in', 'complete'] as const) routes.post(`/account/fake-site-link/${action}`, async (c) => {
    const { owner } = await templateRequester(c);
    const { linkId } = await c.req.json<{ linkId: string }>();
    const link = pending.get(linkId);
    if (!link || link.owner !== owner || link.expires <= Date.now()) return c.json({ error: 'Template sign-in expired' }, 400);
    if (action === 'sign-in') {
      await call(owner, 'auth/link/sign-in', 'POST', 'credential_capture');
      link.signedIn = true;
      return c.json({ status: 'linked' });
    }
    if (!link.signedIn) return c.json({ error: 'Complete the template sign-in first' }, 409);
    const state = await call(owner, 'auth/status', 'GET');
    if (state.status !== 'linked') return c.json({ error: 'Template sign-in needed' }, 409);
    pending.delete(linkId);
    accountsNeedingSignIn.delete(owner);
    return c.json({ status: 'linked' });
  });
  routes.post('/account/fake-site-link/unlink', async (c) => {
    const { owner } = await templateRequester(c);
    await call(owner, 'auth/link/revoke', 'POST', 'credential_revocation');
    for (const [key, link] of pending) if (link.owner === owner) pending.delete(key);
    return c.json({ status: 'not_linked' });
  });
  return routes;
}
