import { describe, expect, it } from 'vitest';
import { siteSignInRoutes } from './sign-in.js';

describe('template account linking routes', () => {
  it('requires completed sign-in, reports link state and revokes through the Credential Service', async () => {
    let linked = false;
    const calls: string[] = [];
    const routes = siteSignInRoutes({ serviceUrl: () => 'http://credential-service', secret: () => 'local-secret', fetchImpl: async (input, init) => {
      const path = input instanceof Request ? input.url : input.toString();
      calls.push(path);
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer v1\./);
      if (path.endsWith('/sign-in')) linked = true;
      if (path.endsWith('/revoke')) linked = false;
      return Response.json({ status: linked ? 'linked' : 'not_linked' });
    } });
    let cookie = '';
    const session = await routes.request('/account/session');
    const header = session.headers.get('set-cookie');
    if (!header) throw new Error('Template account cookie is missing');
    cookie = header.split(';')[0] ?? '';
    if (!cookie) throw new Error('Template account cookie is empty');
    const post = (path: string, body: unknown) => routes.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const start = await (await post('/account/fake-site-link/start', {})).json() as { linkId: string };
    expect((await post('/account/fake-site-link/complete', start)).status).toBe(409);
    expect(await (await post('/account/fake-site-link/sign-in', start)).json()).toEqual({ status: 'linked' });
    expect(await (await post('/account/fake-site-link/complete', start)).json()).toEqual({ status: 'linked' });
    expect(await (await routes.request('/account/sign-ins', { headers: { Cookie: cookie } })).json()).toEqual({ signIns: [{ provider: 'fake-site', name: 'Template site', status: 'linked' }] });
    expect(await (await post('/account/fake-site-link/unlink', {})).json()).toEqual({ status: 'not_linked' });
    expect((await post('/account/fake-site-link/complete', start)).status).toBe(400);
    expect(calls).toContain('http://credential-service/fake-site/auth/link/revoke');
  });

  it('fails loud when the Credential Service refuses sign-in', async () => {
    const routes = siteSignInRoutes({ serviceUrl: () => 'http://credential-service', secret: () => 'local-secret', fetchImpl: async () => new Response('', { status: 503 }) });
    expect((await routes.request('/account/sign-ins')).status).toBe(500);
  });
});
