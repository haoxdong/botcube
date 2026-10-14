import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { accountCookies } from './account-cookies.js';
import { AccountStore } from './account-store.js';
import { accountRoutes } from './accounts.js';
import { HttpError } from './cartridge.js';

/** Registration is the Cartridge's own; this one registers outright. */
class RegisteringStore extends AccountStore {
  register(accountId: string): Promise<void> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      await this.commit(lease, [this.put(this.accountItem({ ...account, status: 'registered' }))]);
    });
  }
}

function app(preferred?: (trusted: string | null) => Promise<string | null>) {
  const store = new RegisteringStore('chat', { key: 'bot', product: 'Bot' }, memoryDocuments());
  const accounts = accountRoutes({
    store: () => store,
    cookies: accountCookies('bot'),
    session: (account) => ({ named: account.displayName ?? null }),
    signIns: async () => [{ site: 'site', name: 'Site', status: 'linked' }],
  });
  const routes = new Hono()
    .onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, error instanceof HttpError ? (error.status as 401) : 500))
    .route('/', accounts.routes)
    .get('/owner', async (c) => c.json((await accounts.owner(c, preferred)).owner));
  return { store, routes };
}

const cookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`))?.split(';')[0] ?? '';

it.each(['anonymous', 'registered'] as const)('reads the %s owner account once per request', async (status) => {
  const { store, routes } = app();
  const { account } = await store.anonymousAccount(undefined);
  if (status === 'registered') await store.register(account.accountId);
  const headers = { Cookie: status === 'registered'
    ? `bot_session=${await store.createSession(account.accountId)}`
    : `bot_account_id=${account.accountId}` };
  const load = vi.spyOn(store, 'loadAccount');

  const response = await routes.request('/owner', { headers });

  expect([response.status, await response.json()]).toEqual([200, account.accountId]);
  expect(load).toHaveBeenCalledExactlyOnceWith(account.accountId);
});

it("acts for the browser's anonymous account, then the signed-in one, until it signs out", async () => {
  const { store, routes } = app();
  const missing = await routes.request('/owner');
  expect([missing.status, await missing.json()]).toEqual([401, { detail: 'Missing bot account cookie' }]);

  const first = await routes.request('/account/session');
  const anonymous = cookie(first, 'bot_account_id');
  expect(await first.json()).toEqual({ accountId: anonymous.split('=')[1], status: 'anonymous', rateTier: expect.any(String), authenticated: false, named: null, signInNeeded: false });
  const { accountId } = await (await routes.request('/account/session', { headers: { Cookie: anonymous } })).json() as { accountId: string };
  expect(await (await routes.request('/owner', { headers: { Cookie: anonymous } })).json()).toBe(accountId);
  expect(await (await routes.request('/account/sign-ins', { headers: { Cookie: anonymous } })).json()).toEqual({ signIns: [{ site: 'site', name: 'Site', status: 'linked' }] });

  const { accountId: other } = await store.anonymousAccount(undefined).then(({ account }) => account);
  await store.register(other);
  const session = `bot_session=${await store.createSession(other)}`;
  expect(await (await routes.request('/owner', { headers: { Cookie: `${anonymous}; ${session}` } })).json()).toBe(other);
  expect(await (await routes.request('/account/session', { headers: { Cookie: `${anonymous}; ${session}` } })).json()).toMatchObject({ accountId: other, status: 'registered', authenticated: true });

  const logout = await routes.request('/auth/logout', { method: 'POST', headers: { Cookie: session } });
  expect(cookie(logout, 'bot_session')).toBe('bot_session=');
  expect(await (await routes.request('/owner', { headers: { Cookie: `${anonymous}; ${session}` } })).json()).toBe(accountId);
});

it("takes the Cartridge's preferred account, keeps its sign-in need and forgets it once deleted", async () => {
  const preferredId = { current: null as string | null };
  const { store, routes } = app(async () => preferredId.current);
  const { account } = await store.anonymousAccount(undefined);
  preferredId.current = account.accountId;
  expect(await (await routes.request('/owner')).json()).toBe(account.accountId);

  await store.markSignInNeeded(account.accountId);
  const anonymous = `bot_account_id=${account.accountId}`;
  expect(await (await routes.request('/account/session', { headers: { Cookie: anonymous } })).json()).toMatchObject({ signInNeeded: true });

  await store.deleteAccount(account.accountId);
  const gone = await routes.request('/account/sign-ins', { headers: { Cookie: anonymous } });
  expect([gone.status, await gone.json()]).toEqual([401, { detail: 'Missing or invalid bot account cookie' }]);
});
