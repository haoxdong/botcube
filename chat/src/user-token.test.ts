import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { Hono } from 'hono';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { accountCookies } from './account-cookies.js';
import { AccountStore } from './account-store.js';
import { accountRoutes } from './accounts.js';
import { HttpError } from './cartridge.js';
import { TurnIdentity } from './turn-identity.js';
import { forwardUserToken } from './user-token.js';

const ISSUER = 'https://chat.example.com';
const key: JsonWebKey = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'key-1' };
const identity = new TurnIdentity({ issuer: ISSUER, keys: [key] });

async function turnUserToken(owner: string, startedAt: Date): Promise<string> {
  const forwardedProps: Record<string, unknown> = {};
  const [token] = await forwardUserToken(identity, forwardedProps, { owner, threadId: 'thread-1', startedAt: startedAt.toISOString() });
  expect(forwardedProps.userToken).toBe(token);
  return String(token);
}

it("expires the Turn's user token at the Turn's timeout, an hour from its start, however late in the Turn it is minted", async () => {
  const startedAt = new Date(Date.now() - 10 * 60_000);

  const token = await turnUserToken('account-1', startedAt);

  const { payload } = await jwtVerify(token, createLocalJWKSet(identity.jwks()), { issuer: ISSUER, audience: 'botcube-user' });
  expect(payload.exp).toBe(Math.floor(startedAt.getTime() / 1000) + 3600);
});

it('mints no user token for a Turn already past its timeout', async () => {
  const forwardedProps: Record<string, unknown> = {};
  const startedAt = new Date(Date.now() - 3601_000).toISOString();

  await expect(forwardUserToken(identity, forwardedProps, { owner: 'account-1', threadId: 'thread-1', startedAt })).rejects.toThrow(`The Turn that started at ${startedAt} has ended`);
  expect(forwardedProps).not.toHaveProperty('userToken');
});

it("signs the Turn's user token for the user-token audience alone, which the Harness's JWT authorizer refuses", async () => {
  const token = await turnUserToken('account-1', new Date());
  const keys = createLocalJWKSet(identity.jwks());
  const harnessBearer = await identity.signServiceToken('botcube-harness');

  await expect(jwtVerify(harnessBearer, keys, { issuer: ISSUER, audience: 'botcube-harness' })).resolves.toBeDefined();
  await expect(jwtVerify(token, keys, { issuer: ISSUER, audience: 'botcube-harness' })).rejects.toThrow('unexpected "aud" claim value');
  await expect(jwtVerify(token, keys, { issuer: ISSUER, audience: 'sts.amazonaws.com' })).rejects.toThrow('unexpected "aud" claim value');
});

it("refuses the Turn's user token as the User's credential at the Chat Service", async () => {
  const store = new AccountStore('chat', { key: 'bot', product: 'Bot' }, memoryDocuments());
  const accounts = accountRoutes({ store: () => store, cookies: accountCookies('bot'), signIns: async () => [] });
  const app = new Hono()
    .onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, error instanceof HttpError ? (error.status as 401) : 500))
    .get('/owner', async (c) => c.json((await accounts.owner(c)).owner));
  const { account } = await store.anonymousAccount(undefined);
  const token = await turnUserToken(account.accountId, new Date());

  const answers = await Promise.all([
    { authorization: `Bearer ${token}` },
    { cookie: `bot_session=${token}` },
    { 'x-botcube-test-user': token },
  ].map(async (headers) => {
    const response = await app.request('/owner', { headers });
    return [response.status, await response.json()];
  }));

  expect(answers).toEqual([
    [401, { detail: 'Missing bot account cookie' }],
    [401, { detail: 'Missing bot account cookie' }],
    [401, { detail: 'Invalid operator Test User token' }],
  ]);
});
