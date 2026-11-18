import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { allowInsecureRequests, Configuration, tokenIntrospection } from 'openid-client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountStore } from './account-store.js';
import { signCredentialServiceInvocation } from './credential-service-token.js';
import { TOKEN_INTROSPECTION_PATH, TOKEN_INTROSPECTION_SCOPE, tokenIntrospectionRoutes } from './token-introspection.js';

const SECRET = 'introspection-test-secret';

class RegisteringStore extends AccountStore {
  register(accountId: string): Promise<void> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      await this.commit(lease, [this.put(this.accountItem({ ...account, status: 'registered' }))]);
    });
  }

  async expiry(token: string) {
    return (await this.session(token))?.expiresAt ?? 0;
  }
}

const store = new RegisteringStore('chat', { key: 'bot', product: 'Bot' }, memoryDocuments());
let server: ServerType;
let endpoint: string;

beforeAll(async () => {
  const routes = tokenIntrospectionRoutes({ sessions: () => store, invocationSecret: SECRET });
  server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: routes.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}${TOKEN_INTROSPECTION_PATH}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

const caller = (secret = SECRET, scope: string | null = TOKEN_INTROSPECTION_SCOPE) =>
  signCredentialServiceInvocation(secret, 'credential-service', 'token-introspection', { scope: scope ?? undefined });

const introspect = (token: string, authorization?: string) => fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) },
  body: new URLSearchParams({ token }),
});

async function signedIn() {
  const { account } = await store.anonymousAccount(undefined);
  await store.register(account.accountId);
  return { accountId: account.accountId, token: await store.createSession(account.accountId) };
}

function rfc7662Client() {
  const config = new Configuration(
    { issuer: new URL(endpoint).origin, introspection_endpoint: endpoint },
    'credential-service',
    undefined,
    (_as, _client, _body, headers) => { headers.set('authorization', `Bearer ${caller()}`); },
  );
  allowInsecureRequests(config);
  return config;
}

it('answers an RFC 7662 client with the live session as {active, sub, exp} and nothing else, extending it', async () => {
  const { accountId, token } = await signedIn();
  const before = await store.expiry(token);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const answer = await tokenIntrospection(rfc7662Client(), token);

  const after = await store.expiry(token);
  expect(answer).toEqual({ active: true, sub: accountId, exp: after });
  expect(after).toBeGreaterThan(before);
});

it.each([
  ['an unknown token', async () => 'sess_unknown'],
  ['a signed-out token', async () => { const { token } = await signedIn(); await store.deleteTrustedSession(token); return token; }],
  ['an anonymous account', async () => { const { account } = await store.anonymousAccount(undefined); return store.createSession(account.accountId); }],
  ['a non-session bearer', async () => caller()],
])('answers %s with {active:false} only', async (_name, token) => {
  const response = await introspect(await token(), `Bearer ${caller()}`);

  expect([response.status, response.headers.get('cache-control'), await response.json()]).toEqual([200, 'no-store', { active: false }]);
});

it.each([
  ['an anonymous caller', undefined],
  ['an unscoped invocation', `Bearer ${caller(SECRET, null)}`],
  ['an invocation scoped to another operation', `Bearer ${caller(SECRET, 'plan_usage')}`],
  ['a caller signed with another secret', `Bearer ${caller('another-secret')}`],
  ['a caller presenting the session itself', 'session'],
])('refuses %s with 401 and never reads the token', async (_name, authorization) => {
  const { token } = await signedIn();
  const before = await store.expiry(token);

  const response = await introspect(token, authorization === 'session' ? `Bearer ${token}` : authorization);

  expect([response.status, response.headers.get('www-authenticate'), await response.json()])
    .toEqual([401, 'Bearer error="invalid_token"', { error: 'invalid_client' }]);
  expect(await store.expiry(token)).toEqual(before);
});

it('refuses a request without a token as invalid_request', async () => {
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${caller()}` } });

  expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request' }]);
});
