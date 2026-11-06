import { signCredentialServiceInvocation } from 'botcube-chat/credential-service-token';
import type { AccountStore } from 'botcube-chat/account-store';
import type { SignIn } from 'botcube-chat/accounts';
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';

export interface SiteSignInOptions {
  serviceUrl: () => string;
  secret: () => string;
  /** The account a request acts for. */
  owner: (c: Context) => Promise<string>;
  store: () => AccountStore;
  fetchImpl?: typeof fetch;
}

/** The fake site's Sign-in: the agent signs in to it through the Credential Service. */
export function siteSignIn(options: SiteSignInOptions): { routes: Hono; signIns: (accountId: string) => Promise<SignIn[]> } {
  const pending = new Map<string, { owner: string; expires: number; signedIn: boolean }>();
  const fetchImpl = options.fetchImpl ?? fetch;
  async function call(account: string, path: string, method: string, scope?: string): Promise<{ status: string }> {
    const url = options.serviceUrl();
    if (!url) throw new Error('Template Credential Service URL is required');
    const response = await fetchImpl(`${url}/fake-site/${path}`, {
      method,
      headers: { Authorization: `Bearer ${signCredentialServiceInvocation(options.secret(), account, 'template-link', { scope })}` },
    });
    if (!response.ok) throw new Error(`Template Credential Service HTTP ${response.status}`);
    const body = await response.json() as { status: string };
    if (typeof body.status !== 'string') throw new Error('Template Credential Service returned malformed link state');
    return body;
  }
  const routes = new Hono();
  routes.post('/account/fake-site-link/start', async (c) => {
    const owner = await options.owner(c);
    const now = Date.now();
    for (const [id, link] of pending) if (link.expires <= now) pending.delete(id);
    const linkId = randomUUID();
    pending.set(linkId, { owner, expires: now + 300_000, signedIn: false });
    return c.json({ linkId });
  });
  for (const action of ['sign-in', 'complete'] as const) routes.post(`/account/fake-site-link/${action}`, async (c) => {
    const owner = await options.owner(c);
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
    await options.store().clearSignInNeeded(owner);
    return c.json({ status: 'linked' });
  });
  routes.post('/account/fake-site-link/unlink', async (c) => {
    const owner = await options.owner(c);
    await call(owner, 'auth/link/revoke', 'POST', 'credential_revocation');
    for (const [key, link] of pending) if (link.owner === owner) pending.delete(key);
    return c.json({ status: 'not_linked' });
  });
  return {
    routes,
    signIns: async (accountId) => [{ site: 'fake-site', name: 'Template site', status: (await call(accountId, 'auth/status', 'GET')).status }],
  };
}
