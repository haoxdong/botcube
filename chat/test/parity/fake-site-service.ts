import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { AccountStore } from '../../src/account-store.js';
import { serveChatService } from '../../src/index.js';
import { signCredentialServiceInvocation } from '../../src/credential-service-token.js';
import { stockAccountStore } from '../../src/stock.js';

/**
 * The stock Chat Service with a stand-in product's own sign-in: the fake site's, which the agent reaches
 * through the template Credential Service, and a refusal any scheduled run reports as the sign-in it needed.
 */
const env = process.env;
const SIGN_IN_NEEDED = 'Template site sign-in needed.';
const accountStore = stockAccountStore(env);

async function credentialService(account: string, path: string, method: string, scope?: string): Promise<{ status: string }> {
  const secret = env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '';
  const response = await fetch(`${env.BOTCUBE_CREDENTIAL_SERVICE_URL}/fake-site/${path}`, {
    method,
    headers: { Authorization: `Bearer ${signCredentialServiceInvocation(secret, account, 'template-link', { scope })}` },
  });
  if (!response.ok) throw new Error(`Template Credential Service HTTP ${response.status}`);
  return await response.json() as { status: string };
}

/** The fake site's link: start, sign in through the Credential Service, complete once it reports linked, and unlink. */
function siteSignIn(owner: (c: Context) => Promise<string>, store: AccountStore): Hono {
  const pending = new Map<string, { owner: string; signedIn: boolean }>();
  const routes = new Hono();
  routes.post('/account/fake-site-link/start', async (c) => {
    const linkId = randomUUID();
    pending.set(linkId, { owner: await owner(c), signedIn: false });
    return c.json({ linkId });
  });
  routes.post('/account/fake-site-link/sign-in', async (c) => {
    const link = pending.get((await c.req.json<{ linkId: string }>()).linkId);
    if (!link || link.owner !== await owner(c)) return c.json({ error: 'Template sign-in expired' }, 400);
    await credentialService(link.owner, 'auth/link/sign-in', 'POST', 'credential_capture');
    link.signedIn = true;
    return c.json({ status: 'linked' });
  });
  routes.post('/account/fake-site-link/complete', async (c) => {
    const { linkId } = await c.req.json<{ linkId: string }>();
    const link = pending.get(linkId);
    if (!link?.signedIn || link.owner !== await owner(c)) return c.json({ error: 'Complete the template sign-in first' }, 409);
    if ((await credentialService(link.owner, 'auth/status', 'GET')).status !== 'linked') return c.json({ error: 'Template sign-in needed' }, 409);
    pending.delete(linkId);
    await store.clearSignInNeeded(link.owner);
    return c.json({ status: 'linked' });
  });
  routes.post('/account/fake-site-link/unlink', async (c) => {
    await credentialService(await owner(c), 'auth/link/revoke', 'POST', 'credential_revocation');
    return c.json({ status: 'not_linked' });
  });
  return routes;
}

serveChatService(env, {
  accountStore,
  ...(env.TEMPLATE_SITE_URL ? { startPage: new URL('/login', env.TEMPLATE_SITE_URL).href } : {}),
  overrides: (chat) => ({
    routes: new Hono().route('/', chat.routes).route('/', siteSignIn(async (c) => (await chat.requester(c)).owner, accountStore)),
    signInNeeded: async (account, outputs) => {
      if (!outputs.some((output) => output.split('\n').some((line) => line === SIGN_IN_NEEDED || line === `[stderr] ${SIGN_IN_NEEDED}`))) return null;
      await accountStore.markSignInNeeded(account);
      return SIGN_IN_NEEDED;
    },
  }),
});
