import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountStore } from './account-store.js';
import { signCredentialServiceInvocation } from './credential-service-token.js';
import { HttpError } from './http-error.js';
import { planModels } from './plan-models.js';

const SECRET = 'test-operator-secret';
const SIGN_IN = { subject: 'user-AbC123', clientId: 'app_dyn_1', refreshToken: 'rt_first' };
let store: AccountStore;
let service: HttpFake;
let app: Hono;
let owner: string;
let other: string;
let reply: { status: number; body: unknown };
let identityAtVaultCall: (string | undefined)[];

beforeEach(async () => {
  store = new AccountStore('accounts', { key: 'acme', product: 'Acme' }, memoryDocuments());
  owner = (await store.anonymousAccount(undefined)).account.accountId;
  other = (await store.anonymousAccount(undefined)).account.accountId;
  identityAtVaultCall = [];
  reply = { status: 200, body: { status: 'stored', subject: SIGN_IN.subject } };
  service = await new HttpFake(async (_request, response) => {
    identityAtVaultCall.push((await store.loadAccount(owner))?.openaiIdentity);
    sendJson(response, reply.status, reply.body);
  }).listen();
  app = planUsageApp(owner);
});

/** Plan Usage's operator routes, bound to the fake Credential Service under a provider prefix it ignores. */
function planUsageApp(ownerAccountId: string | undefined): Hono {
  const { routes } = planModels({ credentialServiceUrl: `${service.url}/provider`, invocationSecret: SECRET, ownerAccountId, store: () => store });
  return new Hono().onError((error, c) => error instanceof HttpError
    ? c.json({ detail: error.detail }, error.status as 401)
    : c.text(String(error), 500)).route('/account/plan-usage/openai', routes);
}

afterEach(async () => { await service.close(); });

const tokenFor = (accountId: string, scope: string) =>
  signCredentialServiceInvocation(SECRET, accountId, 'operator-session', { scope });

function grant(token: string, headers: Record<string, string> = {}) {
  return app.request('/account/plan-usage/openai', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(SIGN_IN),
  });
}

it('stores the owner identity only after the operator capture has been vaulted', async () => {
  const token = tokenFor(owner, 'credential_capture');
  const response = await grant(token, { 'x-botcube-account-id': other });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'stored', subject: SIGN_IN.subject });
  expect((await store.loadAccount(owner))?.openaiIdentity).toBe(SIGN_IN.subject);
  expect((await store.loadAccount(other))?.openaiIdentity).toBeUndefined();
  expect(identityAtVaultCall).toEqual([undefined]);
  expect(service.requests).toHaveLength(1);
  expect(service.requests[0]).toMatchObject({
    method: 'POST', path: '/openai/auth/link/ingest',
    headers: { authorization: `Bearer ${token}`, 'x-botcube-account-id': owner, 'x-botcube-session-id': 'operator-session' },
    body: JSON.stringify(SIGN_IN),
  });
});

it.each(['credential_revocation', 'session_seed'])('refuses an operator with the wrong %s scope before a Vault write', async (scope) => {
  const response = await grant(tokenFor(owner, scope));
  expect(response.status).toBe(401);
  expect(service.requests).toEqual([]);
  expect((await store.loadAccount(owner))?.openaiIdentity).toBeUndefined();
});

it('refuses a configured non-owner before a Vault write', async () => {
  const response = await grant(tokenFor(other, 'credential_capture'));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ detail: 'Plan Usage is only available to the configured owner account' });
  expect(service.requests).toEqual([]);
});

it('fails closed when the trusted owner configuration is absent', async () => {
  app = planUsageApp(undefined);
  const response = await grant(tokenFor(owner, 'credential_capture'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ detail: 'Plan Usage owner account is not configured' });
  expect(service.requests).toEqual([]);
});

it('refuses a valid owner token once its account no longer exists', async () => {
  await store.deleteAccount(owner);
  const response = await grant(tokenFor(owner, 'credential_capture'));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ detail: 'Acme account not found' });
  expect(service.requests).toEqual([]);
});

it('keeps the account unlinked when the Vault refuses the capture', async () => {
  reply = { status: 500, body: { detail: 'Vault write failed' } };
  const response = await grant(tokenFor(owner, 'credential_capture'));
  expect(response.status).toBe(503);
  expect((await store.loadAccount(owner))?.openaiIdentity).toBeUndefined();
});

it('removes the identity before revoking the Vault row and answers the successful removal', async () => {
  await store.recordOpenAISignIn(owner, SIGN_IN.subject);
  reply = { status: 200, body: { status: 'revoked' } };
  const token = tokenFor(owner, 'credential_revocation');
  const response = await app.request('/account/plan-usage/openai', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'removed' });
  expect((await store.loadAccount(owner))?.openaiIdentity).toBeUndefined();
  expect(identityAtVaultCall).toEqual([undefined]);
  expect(service.requests[0]).toMatchObject({
    method: 'POST', path: '/openai/auth/link/revoke',
    headers: { authorization: `Bearer ${token}`, 'x-botcube-account-id': owner, 'x-botcube-session-id': 'operator-session' },
    body: '{}',
  });
});


it('rejects an identity held by another account before replacing the Vault row', async () => {
  await store.recordOpenAISignIn(other, SIGN_IN.subject);
  const response = await grant(tokenFor(owner, 'credential_capture'));
  expect(response.status).toBe(409);
  expect(service.requests).toEqual([]);
  expect((await store.loadAccount(owner))?.openaiIdentity).toBeUndefined();
  expect((await store.loadAccount(other))?.openaiIdentity).toBe(SIGN_IN.subject);
});

it.each(['', 'Bearer invalid'])('refuses an unauthenticated capture before storing credentials (%s)', async (authorization) => {
  const response = await app.request('/account/plan-usage/openai', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(SIGN_IN),
  });
  expect(response.status).toBe(401);
  expect(service.requests).toEqual([]);
});

it('remains unlinked when the Credential Service rejects a capture without a subject', async () => {
  reply = { status: 400, body: { detail: 'subject is required' } };
  const response = await app.request('/account/plan-usage/openai', {
    method: 'POST', headers: { authorization: `Bearer ${tokenFor(owner, 'credential_capture')}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ detail: 'subject is required' });
  expect((await store.loadAccount(owner))?.openaiIdentity).toBeUndefined();
  expect(service.requests[0]?.body).toBe('{}');
});

it('keeps access removed when the Vault refuses revocation', async () => {
  await store.recordOpenAISignIn(owner, SIGN_IN.subject);
  reply = { status: 503, body: { detail: 'Vault deletion failed' } };
  const response = await app.request('/account/plan-usage/openai', {
    method: 'DELETE', headers: { authorization: `Bearer ${tokenFor(owner, 'credential_revocation')}` },
  });
  expect(response.status).toBe(503);
  expect((await store.loadAccount(owner))?.openaiIdentity).toBeUndefined();
  expect(identityAtVaultCall).toEqual([undefined]);
});

// RFC6750 section2.1 permits one or more spaces between Bearer and its token.
// https://www.rfc-editor.org/rfc/rfc6750#section-2.1
it('accepts the valid owner invocation with multiple RFC6750 Bearer separator spaces', async () => {
  const token = tokenFor(owner, 'credential_capture');
  const response = await grant(token, { authorization: `Bearer   ${token}` });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'stored', subject: SIGN_IN.subject });
  expect((await store.loadAccount(owner))?.openaiIdentity).toBe(SIGN_IN.subject);
  expect(service.requests[0]).toMatchObject({
    method: 'POST', path: '/openai/auth/link/ingest',
    headers: { authorization: `Bearer ${token}`, 'x-botcube-account-id': owner, 'x-botcube-session-id': 'operator-session' },
  });
});
