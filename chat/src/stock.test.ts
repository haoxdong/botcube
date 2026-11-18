import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunAgentInput } from '@ag-ui/client';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';
import { motoEndpoint } from '../test/fakes/moto.js';
import { RUNTIME_ARN, createChatTable } from '../test/fakes/stack.js';
import { memoryDocuments } from '../test/memory-documents.js';
import { signCredentialServiceInvocation, verifyCredentialServiceInvocation } from './credential-service-token.js';
import { serveChatService } from './server.js';
import { HttpError, type AccountHistory } from './cartridge.js';
import { stockAccountStore, stockChatService } from './stock.js';

const history: AccountHistory = { delete: async () => undefined, transfer: async () => undefined, ownsMainChat: async () => false, owns: async () => true };

const PUBLIC_EXAMPLE = fileURLToPath(new URL('../../examples/public/deployment-config.json', import.meta.url));

function deploymentConfig(bot: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'stock-deployment-'));
  writeFileSync(join(dir, 'bot.json'), JSON.stringify(bot));
  writeFileSync(join(dir, 'deployment-config.json'), JSON.stringify({ bot: './bot.json' }));
  return join(dir, 'deployment-config.json');
}

const turn = (forwardedProps: Record<string, unknown>) =>
  ({ threadId: 'session-1', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps }) as RunAgentInput;

describe('the stock Chat Service', () => {
  it('stops before serving without a Deployment Config', () => {
    expect(() => stockChatService({})).toThrow('BOTCUBE_DEPLOYMENT_CONFIG is not set');
  });

  it('takes its Agent Identity, Soul and models from the bot settings its Deployment Config names', () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
      agentIdentity: { name: 'Quill', character: 'A drafting agent', avatar: '🪶' },
      soul: 'Write plainly.',
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }, { key: 'echo-2', label: 'Echo 2', description: 'Also echoes', provider: 'echo' }],
    }) })(history);

    expect(service.agentDocuments).toEqual({ agentIdentity: { name: 'Quill', character: 'A drafting agent', vibe: 'Direct, precise, and calm', avatar: '🪶' }, soul: 'Write plainly.' });
    expect(service.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }, { key: 'echo-2', label: 'Echo 2', description: 'Also echoes', provider: 'echo' }]);
  });

  it.each([[undefined, true], [false, false]])('takes its Memory gate from the bot settings (memory %j)', (memory, kept) => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
      agentIdentity: { name: 'Quill', character: 'A drafting agent' },
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
      ...(memory === undefined ? {} : { memory }),
    }) })(history);

    expect(service.memory).toBe(kept);
  });

  it('stops before serving when its bot settings are wrong, naming the field', () => {
    const path = deploymentConfig({ agentIdentity: { name: 'Quill' }, models: [{ key: 'echo', label: 'Echo', provider: 'echo' }] });
    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path })).toThrow(`Bot settings ${join(path, '..', 'bot.json')}: agentIdentity.character: `);
  });

  it('stops before serving a bot that wants the user token in its shell when there are no Turn identity keys to sign it', () => {
    const path = deploymentConfig({ agentIdentity: { name: 'Quill', character: 'A drafting agent' }, models: [{ key: 'echo', label: 'Echo', provider: 'echo' }], userTokenInShell: true });

    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path })).toThrow('userTokenInShell: the user token is signed with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path, BOTCUBE_TURN_IDENTITY_KEYS: '[]' })).not.toThrow();
  });

  it('offers only the bot settings\' models, with no account models', async () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE })(history);

    expect(service.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
    expect(await service.accountModels({ owner: 'owner' })).toEqual([]);
    await expect(service.accountModel({ owner: 'owner' }, 'openai-plan:gpt-5.5')).resolves.toBeUndefined();
  });

  it("files each request under the browser's account and forwards the Turn with its Agent Computer", async () => {
    const env = { BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE };
    const service = stockChatService(env, { accountStore: stockAccountStore(env, memoryDocuments()) })(history);
    const route = new Hono()
      .onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, 500))
      .route('/', service.routes)
      .get('/requester', async (c) => c.json(await service.requester(c)));

    expect(await (await route.request('/requester')).json()).toEqual({ detail: 'Missing template account cookie' });
    const session = await route.request('/account/session');
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toMatch(/^template_account_id=acct_/);
    const requester = await (await route.request('/requester', { headers: { Cookie: cookie } })).json() as { owner: string };
    expect(requester).toEqual({ owner: (await session.json() as { accountId: string }).accountId, anonymous: true });
    expect(service.filingUserId(requester.owner)).toBe(requester.owner);
    expect(await (await route.request('/account/sign-ins', { headers: { Cookie: cookie } })).json()).toEqual({ signIns: [] });
    expect(await service.invocationPayload(turn({ model: 'echo' }), requester, service.models[0])).toEqual({
      ...turn({ model: 'echo' }),
      forwardedProps: { model: 'echo', agentComputerCdpUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:8123\/agent-computer\/cdp\?token=/) },
    });
  });

  it("replaces a client-supplied CDP endpoint with its own Agent Computer's", async () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE, BOTCUBE_AGENT_COMPUTER_CDP_URL: 'ws://chat-service:8123/agent-computer/cdp' })(history);
    const input = turn({ model: 'echo', agentComputerCdpUrl: 'ws://untrusted.invalid' });
    expect(await service.invocationPayload(input, { owner: 'owner' }, service.models[0])).toEqual({
      ...input,
      forwardedProps: { model: 'echo', agentComputerCdpUrl: expect.stringMatching(/^ws:\/\/chat-service:8123\/agent-computer\/cdp\?token=/) },
    });
  });

  it('serves Files from EFS, refusing them until EFS is configured', async () => {
    const env = { BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE };
    const service = stockChatService(env, { accountStore: stockAccountStore(env, memoryDocuments()) })(history);
    const route = new Hono().onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, error instanceof HttpError ? error.status as 503 : 500)).route('/', service.routes);
    const cookie = (await route.request('/account/session')).headers.get('set-cookie')?.split(';')[0] ?? '';

    const files = await route.request('/files', { headers: { Cookie: cookie } });
    expect(files.status).toBe(503);
    expect(await files.json()).toEqual({ detail: expect.stringContaining('Files on EFS are not configured') });
  });
});

describe("the stock Chat Service's Plan Usage", () => {
  const SECRET = 'invocation-secret';
  const PLAN_OWNER = 'acct_plan_owner_0000000000';
  const model = { key: 'openai-plan:gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Plan model', provider: 'openai' };
  const catalog = { models: [
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', description: 'Plan model', visibility: 'list' },
    { slug: 'codex-internal', display_name: 'Codex internal', visibility: 'hide' },
  ] };
  // The Credential Service's OpenAI provider: its Vault holds Sign-ins, and its relay serves only a vaulted plan's catalog.
  const vault = new Set([PLAN_OWNER]);
  const credentialService = new HttpFake((request, response) => {
    const invocation = verifyCredentialServiceInvocation(SECRET, String(request.headers.authorization).replace(/^Bearer /, ''));
    if (invocation === null) return sendJson(response, 401, { detail: 'Invalid Credential Service invocation token' });
    const route = `${request.method} ${request.path}`;
    if (route === 'POST /openai/auth/link/ingest' && invocation.scope === 'credential_capture') {
      vault.add(invocation.accountId);
      return sendJson(response, 200, { status: 'stored', subject: (JSON.parse(request.body) as { subject: string }).subject });
    }
    if (route === 'POST /openai/auth/link/revoke' && invocation.scope === 'credential_revocation') {
      vault.delete(invocation.accountId);
      return sendJson(response, 200, { status: 'revoked' });
    }
    if (route !== 'GET /openai/v1/models') return sendJson(response, 404, { detail: 'Not Found' });
    if (!vault.has(invocation.accountId)) return sendJson(response, 401, { error: { type: 'plan_usage', message: 'no credential' } });
    sendJson(response, 200, catalog);
  });
  beforeAll(async () => { await credentialService.listen(); });
  afterAll(async () => { await credentialService.close(); });

  const claims = (payload: { forwardedProps?: Record<string, unknown> }) => JSON.parse(Buffer.from(
    String(payload.forwardedProps?.credentialServiceInvocationToken).split('.')[1] ?? '', 'base64url',
  ).toString()) as Record<string, unknown>;

  async function planUsage() {
    const env = {
      BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE,
      BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url,
      BOTCUBE_CREDENTIAL_INVOCATION_SECRET: SECRET,
      BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID: PLAN_OWNER,
    };
    const documents = memoryDocuments();
    const accountStore = stockAccountStore(env, documents);
    const account = (accountId: string, status: 'registered' | 'test', more: Record<string, unknown> = {}) => documents.send(new PutCommand({
      TableName: 'chat', Item: { pk: `ACCOUNT#${accountId}`, sk: 'META', record: { accountId, status, rateTier: 'authenticated', version: 1, createdAt: 1, updatedAt: 1, ...more } },
    }));
    await account(PLAN_OWNER, 'registered');
    await accountStore.recordOpenAISignIn(PLAN_OWNER, 'openai-owner');
    return { service: stockChatService(env, { accountStore })(history), account, accountStore };
  }

  it("offers the plan owner his plan's listed models, and runs his Turn on his plan", async () => {
    const { service } = await planUsage();

    expect(await service.accountModels({ owner: PLAN_OWNER }, { refresh: true })).toEqual([model]);
    expect(await service.accountModel({ owner: PLAN_OWNER }, model.key)).toEqual(model);
    const payload = await service.invocationPayload(turn({ model: model.key }), { owner: PLAN_OWNER }, model);
    expect(claims(payload)).toMatchObject({ account_id: PLAN_OWNER, plan_account_id: PLAN_OWNER, model_id: 'gpt-5.6-sol' });
  });

  it("serves the Chat's Test Users on the owner's plan until their deletion is pending, and no other account", async () => {
    const { service, account, accountStore } = await planUsage();
    const testUser = 'acct_plan_test_00000000000';
    const other = 'acct_plan_other_0000000000';
    await account(testUser, 'test');
    await account(other, 'registered', { openaiIdentity: 'openai-other' });
    const fetchedBefore = credentialService.requests.length;

    expect(await service.accountModels({ owner: testUser }, { refresh: true })).toEqual([model]);
    expect(await service.accountModels({ owner: other }, { refresh: true })).toEqual([]);
    expect(await service.accountModel({ owner: other }, model.key)).toBeUndefined();
    expect(credentialService.requests.slice(fetchedBefore).map((request) => request.headers['x-botcube-account-id'])).toEqual([PLAN_OWNER]);
    expect((await accountStore.loadAccount(testUser))?.openaiIdentity).toBeUndefined();
    expect(claims(await service.invocationPayload(turn({ model: model.key }), { owner: testUser }, model)))
      .toMatchObject({ account_id: testUser, plan_account_id: PLAN_OWNER });
    expect(claims(await service.invocationPayload(turn({ model: 'echo' }), { owner: testUser }, service.models[0])))
      .not.toHaveProperty('plan_account_id');

    await account(testUser, 'test', { deletionOperationId: 'deleting' });
    expect(await service.accountModels({ owner: testUser })).toEqual([]);
    expect(claims(await service.invocationPayload(turn({ model: model.key }), { owner: testUser }, model)))
      .toMatchObject({ account_id: testUser, plan_account_id: testUser });
  });

  it('offers no plan without a configured owner, or before the owner signs in to OpenAI', async () => {
    const { accountStore } = await planUsage();
    const bound = { BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE, BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: SECRET };
    expect(await stockChatService(bound, { accountStore })(history).accountModels({ owner: PLAN_OWNER }, { refresh: true })).toEqual([]);

    await accountStore.removeOpenAISignIn(PLAN_OWNER);
    const signedOut = stockChatService({ ...bound, BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID: PLAN_OWNER }, { accountStore })(history);
    expect(await signedOut.accountModels({ owner: PLAN_OWNER }, { refresh: true })).toEqual([]);
  });

  it('fails loud when the plan catalog cannot be fetched, keeping the models last listed', async () => {
    const { service, accountStore } = await planUsage();
    expect(await service.accountModels({ owner: PLAN_OWNER }, { refresh: true })).toEqual([model]);
    const refused = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE, BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url,
      BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'wrong-secret', BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID: PLAN_OWNER }, { accountStore })(history);

    await expect(refused.accountModels({ owner: PLAN_OWNER }, { refresh: true }))
      .rejects.toMatchObject({ status: 503, detail: 'Credential Service plan catalog failed with HTTP 401' });
    expect(await refused.accountModels({ owner: PLAN_OWNER })).toEqual([model]);
  });

  it('refuses an OpenAI Sign-in for any account but the owner, and any while the Credential Service is unbound', async () => {
    const { accountStore, account } = await planUsage();
    const other = 'acct_plan_other_0000000000';
    await account(other, 'registered');
    const routes = (env: Record<string, string>) => new Hono()
      .onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, error instanceof HttpError ? error.status as 403 : 500))
      .route('/', stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: SECRET, BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID: PLAN_OWNER, ...env }, { accountStore })(history).routes);
    const signIn = (route: Hono, accountId: string) => route.request('/account/plan-usage/openai', {
      method: 'POST',
      headers: { authorization: `Bearer ${signCredentialServiceInvocation(SECRET, accountId, 'operator', { scope: 'credential_capture' })}` },
      body: JSON.stringify({ subject: 'openai-other' }),
    });
    const ingests = () => credentialService.requests.filter((request) => request.path === '/openai/auth/link/ingest').length;
    const before = ingests();

    const notOwner = await signIn(routes({ BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url }), other);
    expect([notOwner.status, await notOwner.json()]).toEqual([403, { detail: 'Plan Usage is only available to the configured owner account' }]);
    const unbound = await signIn(routes({}), PLAN_OWNER);
    expect([unbound.status, await unbound.json()]).toEqual([503, { detail: 'The Credential Service is not configured: set BOTCUBE_CREDENTIAL_SERVICE_URL' }]);
    expect(ingests()).toBe(before);
    expect((await accountStore.loadAccount(other))?.openaiIdentity).toBeUndefined();
  });

  it('lets the operator sign the owner in to OpenAI and out again over HTTP, which shows and then empties his catalog', async () => {
    const endpoint = motoEndpoint();
    const table = `stock-plan-${Math.random().toString(36).slice(2)}`;
    await createChatTable(endpoint, table);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoint);
    const base = {
      PORT: '0', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: endpoint, AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      BOTCUBE_CHAT_TABLE: table, BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE,
      BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: SECRET,
    };
    const { account: { accountId: owner } } = await stockAccountStore(base).anonymousAccount(undefined);
    const env = { ...base, BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID: owner };
    const server = serveChatService(stockChatService(env), env);
    try {
      await once(server, 'listening');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const models = async () => ((await (await fetch(`${url}/agent/models`, { headers: { cookie: `template_account_id=${owner}` } })).json()) as { models: unknown[] }).models;
      const operator = (method: 'POST' | 'DELETE', scope: string) => fetch(`${url}/account/plan-usage/openai`, {
        method,
        headers: { authorization: `Bearer ${signCredentialServiceInvocation(SECRET, owner, 'operator', { scope })}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ subject: 'openai-http-owner', refreshToken: 'rt' }) } : {}),
      });

      expect(await models()).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
      const signedIn = await operator('POST', 'credential_capture');
      expect([signedIn.status, await signedIn.json()]).toEqual([200, { status: 'stored', subject: 'openai-http-owner' }]);
      expect(await models()).toEqual([model, { key: 'echo', label: 'Echo', provider: 'echo' }]);

      const signedOut = await operator('DELETE', 'credential_revocation');
      expect([signedOut.status, await signedOut.json()]).toEqual([200, { status: 'removed' }]);
      expect(vault.has(owner)).toBe(false);
      expect(await models()).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });
});
