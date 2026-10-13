import { accountRoutes } from 'botcube-chat/accounts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { memoryDocuments } from '../../../chat/test/memory-documents.js';
import { templateAccountStore, templateCookies } from './account.js';
import { siteSignIn } from './sign-in.js';

/** The template's account routes with its fake-site Sign-in, as the Cartridge mounts them. */
function signInApp(fetchImpl: typeof fetch) {
  const accountStore = templateAccountStore({}, memoryDocuments());
  const store = () => accountStore;
  const signIn = siteSignIn({
    serviceUrl: () => 'http://credential-service',
    secret: () => 'local-secret',
    owner: async (c) => (await accounts.owner(c)).owner,
    store,
    fetchImpl,
  });
  const accounts = accountRoutes({ store, cookies: templateCookies, signIns: (account) => signIn.signIns(account.accountId) });
  return { accountStore, routes: new Hono().route('/', accounts.routes).route('/', signIn.routes) };
}

describe('template account linking routes', () => {
  it('requires completed sign-in, reports link state and revokes through the Credential Service', async () => {
    let linked = false;
    const calls: string[] = [];
    const { accountStore, routes } = signInApp(async (input, init) => {
      const path = input instanceof Request ? input.url : input.toString();
      calls.push(path);
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer v1\./);
      if (path.endsWith('/sign-in')) linked = true;
      if (path.endsWith('/revoke')) linked = false;
      return Response.json({ status: linked ? 'linked' : 'not_linked' });
    });
    const session = await routes.request('/account/session');
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Template account cookie is missing');
    const post = (path: string, body: unknown) => routes.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const { accountId } = await session.json() as { accountId: string };
    await accountStore.markSignInNeeded(accountId);
    const start = await (await post('/account/fake-site-link/start', {})).json() as { linkId: string };
    expect((await post('/account/fake-site-link/complete', start)).status).toBe(409);
    expect(await (await post('/account/fake-site-link/sign-in', start)).json()).toEqual({ status: 'linked' });
    expect(await (await post('/account/fake-site-link/complete', start)).json()).toEqual({ status: 'linked' });
    expect(await (await routes.request('/account/session', { headers: { Cookie: cookie } })).json()).toMatchObject({ accountId, signInNeeded: false });
    expect(await (await routes.request('/account/sign-ins', { headers: { Cookie: cookie } })).json()).toEqual({ signIns: [{ site: 'fake-site', name: 'Template site', status: 'linked' }] });
    expect(await (await post('/account/fake-site-link/unlink', {})).json()).toEqual({ status: 'not_linked' });
    expect((await post('/account/fake-site-link/complete', start)).status).toBe(400);
    expect(calls).toContain('http://credential-service/fake-site/auth/link/revoke');
  });

  it('fails loud when the Credential Service refuses sign-in', async () => {
    const { routes } = signInApp(async () => new Response('', { status: 503 }));
    const cookie = (await routes.request('/account/session')).headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await routes.request('/account/sign-ins', { headers: { Cookie: cookie } })).status).toBe(500);
  });
});
