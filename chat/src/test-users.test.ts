import { it, expect } from 'vitest';
import { Hono } from 'hono';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountStore } from './account-store.js';
import { accountRoutes } from './accounts.js';
import { accountCookies } from './account-cookies.js';
import { HttpError } from './cartridge.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

it('allows an operator Test User to check isolation without a public login or Sign-in', async () => {
  const documents = memoryDocuments();
  const store = new AccountStore('accounts', { key: 'template', product: 'Template' }, documents);
  const accountId = 'acct_operator_test';
  const token = 'test_operator_only';
  await documents.send(new PutCommand({ TableName: 'accounts', Item: {
    pk: `ACCOUNT#${accountId}`, sk: 'META', record: {
      version: 1, accountId, status: 'test', rateTier: 'test', createdAt: 1, updatedAt: 1,
    },
  } }));
  await documents.send(new PutCommand({ TableName: 'accounts', Item: {
    pk: `TOKEN#${token}`, sk: 'META', record: {
      accountId, kind: 'test-user', createdAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 60,
    },
  } }));
  const accounts = accountRoutes({ store: () => store, cookies: accountCookies('template'), signIns: async () => [], deleteTestUser: async (id) => { await store.deleteAccount(id); } });
  const app = new Hono().onError((error) => new Response(JSON.stringify({ detail: error.message }), { status: error instanceof HttpError ? error.status : 500 }));
  app.get('/owner', async (c) => c.json(await accounts.owner(c)));
  app.route('/', accounts.routes);
  const request = (header: string) => app.request('/owner', { headers: { 'x-botcube-test-user': header } });

  expect((await (await request(token)).json()).owner).toBe(accountId);
  expect((await request('test_unknown')).status).toBe(401);
  expect(await store.sessionAccount(token)).toBeNull();
  await expect(store.recordOpenAISignIn(accountId, 'test-subject')).rejects.toThrow('Test Users cannot have Sign-ins');
  await expect(store.createSession(accountId)).rejects.toThrow('Test Users cannot log in');
  const headers = { 'x-botcube-test-user': token };
  const bootstrap = await app.request('/account/session', { headers });
  expect(await bootstrap.json()).toMatchObject({ accountId, status: 'test', authenticated: true });
  expect(bootstrap.headers.getSetCookie()).toEqual([]);
  expect([...documents.items.values()].filter(({ pk, sk }) => String(pk).startsWith('ACCOUNT#') && sk === 'META')).toHaveLength(1);
  expect((await app.request('/account/session', { headers: { 'x-botcube-test-user': 'test_unknown' } })).status).toBe(401);
  expect(await (await app.request('/account/sign-ins', { headers })).json()).toEqual({ signIns: [] });
  expect((await app.request('/account/profile', { headers })).status).toBe(200);
  const edited = await app.request('/account/profile', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Isolated Test User' }) });
  expect(await edited.json()).toMatchObject({ displayName: 'Isolated Test User' });
  expect((await store.loadAccount(accountId))?.displayName).toBe('Isolated Test User');
  await documents.send(new PutCommand({ TableName: 'accounts', Item: {
    pk: 'ACCOUNT#acct_owner', sk: 'META', record: { version: 1, accountId: 'acct_owner', status: 'registered', rateTier: 'authenticated', createdAt: 1, updatedAt: 1 },
  } }));
  const ownerSession = await store.createSession('acct_owner');
  const logout = await app.request('/auth/logout', { method: 'POST', headers: { ...headers, cookie: `template_session=${ownerSession}` } });
  expect(logout.status).toBe(403);
  expect(await store.sessionAccountId(ownerSession)).toBe('acct_owner');

  expect(await store.sessionAccount(token)).toBeNull();
  expect((await app.request('/operator/test-user', { method: 'DELETE' })).status).toBe(401);
  expect((await app.request('/operator/test-user', { method: 'DELETE', headers: { 'x-botcube-test-user': token } })).status).toBe(204);
  expect((await request(token)).status).toBe(401);
});
