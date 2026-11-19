import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunAgentInput } from '@ag-ui/client';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeSessionApi } from '../test/fakes/fake-backends.js';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';
import { StandInOidcIssuer } from '../test/fakes/oidc-issuer.js';
import { RUNTIME_ARN, createChatTable } from '../test/fakes/stack.js';
import { Browser } from '../test/parity/browser.js';
import { memoryDocuments } from '../test/memory-documents.js';
import { signCredentialServiceInvocation, verifyCredentialServiceInvocation } from './credential-service-token.js';
import { directoryOf } from './files-shared.js';
import { filingUserId } from './filing-user-id.js';
import { assertReservedMainIdentity } from './scheduled-run-delivery.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { serveChatService } from './server.js';
import { HttpError, type AccountHistory } from './cartridge.js';
import { AccountStore } from './account-store.js';
import { stockAccountStore, stockChatService } from './stock.js';

/** How often a Chat looked for a local Chromium. */
const chromium = vi.hoisted(() => ({ lookups: 0 }));
vi.mock('./local-chromium.js', async (original) => {
  const actual = await original<typeof import('./local-chromium.js')>();
  return { ...actual, findChromium: (env: NodeJS.ProcessEnv) => { chromium.lookups += 1; return actual.findChromium(env); } };
});

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
      accountKey: 'quill',
      soul: 'Write plainly.',
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }, { key: 'echo-2', label: 'Echo 2', description: 'Also echoes', provider: 'echo' }],
    }) })(history);

    expect(service.agentDocuments).toEqual({ agentIdentity: { name: 'Quill', character: 'A drafting agent', vibe: 'Direct, precise, and calm', avatar: '🪶' }, soul: 'Write plainly.' });
    expect(service.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }, { key: 'echo-2', label: 'Echo 2', description: 'Also echoes', provider: 'echo' }]);
  });

  it.each([[undefined, true], [false, false]])('takes its Memory gate from the bot settings (memory %j)', (memory, kept) => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
      agentIdentity: { name: 'Quill', character: 'A drafting agent' },
      accountKey: 'quill',
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
      ...(memory === undefined ? {} : { memory }),
    }) })(history);

    expect(service.memory).toBe(kept);
  });

  it('stops before serving when its bot settings are wrong, naming the field', () => {
    const path = deploymentConfig({ agentIdentity: { name: 'Quill' }, accountKey: 'quill', models: [{ key: 'echo', label: 'Echo', provider: 'echo' }] });
    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path })).toThrow(`Bot settings ${join(path, '..', 'bot.json')}: agentIdentity.character: `);
  });

  it('stops before serving a bot that wants the user token in its shell when there are no Turn identity keys to sign it', () => {
    const path = deploymentConfig({ agentIdentity: { name: 'Quill', character: 'A drafting agent' }, accountKey: 'quill', models: [{ key: 'echo', label: 'Echo', provider: 'echo' }], userTokenInShell: true });

    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path })).toThrow('userTokenInShell: the user token is signed with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path, BOTCUBE_TURN_IDENTITY_KEYS: '[]' })).not.toThrow();
  });

  it('offers only the bot settings\' models, with no account models', async () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE })(history);

    expect(service.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
    expect(await service.accountModels({ owner: 'owner' })).toEqual([]);
    await expect(service.accountModel({ owner: 'owner' }, 'openai-plan:gpt-5.5')).resolves.toBeUndefined();
  });

  it("keeps signed in the sessions an earlier Chat minted under the bot's account key", async () => {
    const env = { BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
      agentIdentity: { name: 'Acme', character: 'A test bot' }, accountKey: 'acme', models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
    }) };
    const documents = memoryDocuments();
    const accountId = 'acct_earlier_chat_000000000';
    await documents.send(new PutCommand({
      TableName: 'chat', Item: { pk: `ACCOUNT#${accountId}`, sk: 'META', record: { accountId, status: 'registered', displayName: 'Ada', rateTier: 'authenticated', version: 1, createdAt: 1, updatedAt: 1 } },
    }));
    const token = await new AccountStore('chat', { key: 'acme', product: 'Acme' }, documents).createSession(accountId);

    const accountStore = stockAccountStore(env, documents);
    const route = new Hono().route('/', stockChatService(env, { accountStore })(history).routes);

    expect((await accountStore.liveSession(token))?.account.accountId).toBe(accountId);
    const profile = await route.request('/account/profile', { headers: { Cookie: `acme_session=${token}` } });
    expect([profile.status, await profile.json()]).toEqual([200, { displayName: 'Ada', photoUrl: null }]);
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
    expect(service.filingUserId(requester.owner)).toBe(filingUserId('template', requester.owner));
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

describe("the stock Chat Service's filing ID", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the Memory, Turns and scheduled Main Chat an earlier Chat filed under the bot's account key", async () => {
    const sessionApi = new FakeSessionApi();
    const harness = new HttpFake((_, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"type":"RUN_FINISHED"}\n\n');
    });
    await Promise.all([sessionApi.listen(), harness.listen()]);
    closers.push(() => sessionApi.close(), () => harness.close());
    const table = `chat-${Math.random().toString(36).slice(2)}`;
    await createChatTable(motoEndpoint(), table);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', motoEndpoint());
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = {
      PORT: '0',
      BOTCUBE_CHAT_TABLE: table,
      BOTCUBE_LOCAL_SESSION_API_URL: sessionApi.url,
      BOTCUBE_LOCAL_HARNESS_URL: harness.url,
      BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
        agentIdentity: { name: 'Quill', character: 'A drafting agent', avatar: '🪶' },
        accountKey: 'quill',
        models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
        memory: true,
      }),
    };
    const service = stockChatService(env);
    const server = serveChatService(service, env);
    closers.push(() => new Promise((resolve) => { server.close(() => resolve()); }));
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = await fetch(`${url}/account/session`);
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    const { accountId: owner } = await session.json() as { accountId: string };
    // What the earlier Chat filed: its Memory and Main Chat under quill_<hex>.
    const filed = filingUserId('quill', owner);
    sessionApi.memories.set(filed, [{ id: 'memory-1', text: 'Prefers short answers' }]);
    const client = new DynamoDBClient(motoAws());
    closers.push(async () => { client.destroy(); });
    const metadata = new DynamoDBSessionMetadata(table, client);
    const mainChat = await metadata.mainChat(owner, filed);

    expect(await (await fetch(`${url}/agent/memory`, { headers: { Cookie: cookie } })).json()).toEqual({
      lines: [{ id: 'memory-1', text: 'Prefers short answers' }],
    });
    const { id: sideChat } = await (await fetch(`${url}/threads`, { method: 'POST', headers: { Cookie: cookie } })).json() as { id: string };
    const turn = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ threadId: sideChat, runId: 'run-1', state: {}, messages: [{ id: 'm1', role: 'user', content: 'hello' }], tools: [], context: [], forwardedProps: { model: 'echo' } }),
    });
    expect(await turn.text()).toBe('data: {"type":"RUN_FINISHED"}\n\n');
    const invocations = harness.requests.filter(({ path }) => path === '/invocations').map(({ body }) => JSON.parse(String(body)) as RunAgentInput);
    expect(invocations.map(({ threadId, forwardedProps }) => [threadId, forwardedProps.sessionUserId])).toContainEqual([sideChat, filed]);
    const scheduled = service(history).filingUserId(owner);
    expect(await metadata.mainChat(owner, scheduled)).toBe(mainChat);
    // A delivery reserved for the Main Chat checks the filing ID the scheduled run carries.
    await expect(assertReservedMainIdentity(metadata, 'earlier-owner', owner, mainChat, scheduled)).resolves.toBeUndefined();
  });
});

describe("the stock Chat Service's Agent Computer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('prepares a Session in the managed AgentCore browser when one is configured, never looking for Chromium', async () => {
    const lookups = chromium.lookups;
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(String(url));
      return Response.json({ streams: { automationStream: { streamEndpoint: 'wss://stream.test/awake', streamStatus: 'ENABLED' } } });
    });
    const env = {
      BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE,
      PATH: '',
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: 'http://agentcore.test',
      AGENTCORE_AGENT_COMPUTER_BROWSER_ID: 'agent-computer-browser',
      BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET: 'policy-bucket',
      BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY: 'agent-computer/chrome-policy.json',
    };
    const accountStore = stockAccountStore(env, memoryDocuments());
    // The Session's computer is awake in AgentCore already, so preparing it asks AgentCore who drives it.
    await accountStore.withAgentComputerLease('acct_owner', () => accountStore.saveRunningAgentComputer({
      accountId: 'acct_owner', threadId: 'session-1', sessionId: 'browser-1', phase: 'awake', idleDeadline: Date.now() + 60_000,
    }), 'session-1');
    const service = stockChatService(env, { accountStore })(history);

    await service.warmSession({ owner: 'acct_owner' }, 'session-1');

    await vi.waitFor(() => expect(requests).toContain('http://agentcore.test/browsers/agent-computer-browser/sessions/get?sessionId=browser-1'));
    expect(chromium.lookups).toBe(lookups);
    await service.sleepAgentComputers?.().slept;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const GUEST_START = new Date('2026-11-01T12:00:00Z');

/** EFS Files over a local directory, as the Chat Service's own Files tests mount it. */
const efsFiles = () => ({
  BOTCUBE_FILES_EFS_ARN: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc',
  BOTCUBE_FILES_EFS_ROOT: mkdtempSync(join(tmpdir(), 'stock-files-')),
  BOTCUBE_FILES_LINKS_URL: 'https://files.example.test/',
  BOTCUBE_FILES_SIGNING_KEY: 'k'.repeat(64),
  BOTCUBE_FILES_MOUNT_ROLE_ARN: 'arn:aws:iam::123456789012:role/files-mount',
  BOTCUBE_FILES_MOUNT_TARGET_IP: '192.0.2.12',
});

describe("the stock Chat Service's account deletion", () => {
  const SECRET = 'invocation-secret';
  // The Credential Service's Vault: the accounts it holds credentials for, and those whose revoke it refuses.
  const vault = new Set<string>();
  const refusing = new Set<string>();
  const credentialService = new HttpFake((request, response) => {
    const invocation = verifyCredentialServiceInvocation(SECRET, String(request.headers.authorization).replace(/^Bearer /, ''));
    if (invocation === null || request.headers['x-botcube-account-id'] !== invocation.accountId) {
      return sendJson(response, 401, { detail: 'Invalid Credential Service invocation token' });
    }
    if (`${request.method} ${request.path}` !== 'POST /account/revoke' || invocation.scope !== 'credential_revocation') {
      return sendJson(response, 404, { detail: 'Not Found' });
    }
    if (refusing.has(invocation.accountId)) return sendJson(response, 500, { detail: 'Vault unavailable' });
    vault.delete(invocation.accountId);
    sendJson(response, 200, { status: 'revoked' });
  });
  beforeAll(async () => { await credentialService.listen(); });
  afterAll(async () => { await credentialService.close(); });

  it("revokes a Test User's credentials at the Credential Service before erasing it, and keeps it when the revoke fails", async () => {
    const endpoint = motoEndpoint();
    const table = `stock-delete-${Math.random().toString(36).slice(2)}`;
    await createChatTable(endpoint, table);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoint);
    const env = {
      PORT: '0', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: endpoint, AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      BOTCUBE_CHAT_TABLE: table, BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE,
      BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: SECRET,
      ...efsFiles(),
    };
    const documents = DynamoDBDocumentClient.from(new DynamoDBClient(motoAws()));
    const testUser = async (accountId: string) => {
      const token = `test_${accountId}`;
      await documents.send(new PutCommand({ TableName: table, Item: { pk: `ACCOUNT#${accountId}`, sk: 'META',
        record: { version: 1, accountId, status: 'test', rateTier: 'test', createdAt: 1, updatedAt: 1 } } }));
      await documents.send(new PutCommand({ TableName: table, Item: { pk: `TOKEN#${token}`, sk: 'META',
        record: { accountId, kind: 'test-user', createdAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 600 } } }));
      vault.add(accountId);
      const directory = join(env.BOTCUBE_FILES_EFS_ROOT, basename(directoryOf(accountId)));
      mkdirSync(directory);
      writeFileSync(join(directory, 'kept.txt'), 'kept');
      return token;
    };
    const deleted = await testUser('acct_stock_delete_revoked');
    const refused = await testUser('acct_stock_delete_refused');
    refusing.add('acct_stock_delete_refused');
    const store = stockAccountStore(env);
    const server = serveChatService(stockChatService(env), env);
    try {
      await once(server, 'listening');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const deleteTestUser = (token: string) => fetch(`${url}/operator/test-user`, { method: 'DELETE', headers: { 'x-botcube-test-user': token } });

      expect((await deleteTestUser(deleted)).status).toBe(204);
      expect(vault.has('acct_stock_delete_revoked')).toBe(false);
      expect(await store.loadAccount('acct_stock_delete_revoked')).toBeNull();
      expect(existsSync(join(env.BOTCUBE_FILES_EFS_ROOT, basename(directoryOf('acct_stock_delete_revoked'))))).toBe(false);

      const failed = await deleteTestUser(refused);
      expect([failed.status, await failed.json()]).toEqual([503, { detail: 'Credential Service account revoke failed with HTTP 500' }]);
      expect(vault.has('acct_stock_delete_refused')).toBe(true);
      expect(await store.operatorTestUser(refused)).toMatchObject({ accountId: 'acct_stock_delete_refused', status: 'test' });
      expect(existsSync(join(env.BOTCUBE_FILES_EFS_ROOT, basename(directoryOf('acct_stock_delete_refused')), 'kept.txt'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });

  async function guestService(table: string, endpoint: string) {
    const env = {
      PORT: '0', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: endpoint, AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      BOTCUBE_CHAT_TABLE: table, BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE,
      BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: SECRET,
    };
    const server = serveChatService(stockChatService(env), env);
    await once(server, 'listening');
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      store: stockAccountStore(env),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /** A Guest that signed in 31 days ago and holds a credential; the Chat Service that made it has stopped. */
  async function expiredGuest() {
    vi.useFakeTimers({ toFake: ['Date'], now: GUEST_START });
    const endpoint = motoEndpoint();
    const table = `stock-guest-${Math.random().toString(36).slice(2)}`;
    await createChatTable(endpoint, table);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoint);
    const first = await guestService(table, endpoint);
    const { accountId } = await (await fetch(`${first.url}/account/session`)).json() as { accountId: string };
    await first.close();
    vault.add(accountId);
    vi.setSystemTime(GUEST_START.getTime() + 31 * DAY_MS);
    return { accountId, table, endpoint };
  }

  it("finishes on startup a retired account's Files cleanup an earlier Chat left pending", async () => {
    const endpoint = motoEndpoint();
    const table = `stock-files-${Math.random().toString(36).slice(2)}`;
    await createChatTable(endpoint, table);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoint);
    const env = { PORT: '0', AWS_REGION: 'us-east-1', BOTCUBE_CHAT_TABLE: table, BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE, ...efsFiles() };
    const retired = join(env.BOTCUBE_FILES_EFS_ROOT, basename(directoryOf('acct_stock_files_retired')));
    mkdirSync(retired);
    writeFileSync(join(retired, 'left.txt'), 'left');
    const store = stockAccountStore(env);
    // Its last Files credential ran out two days ago, past the grace day.
    await store.retireFiles('acct_stock_files_retired', null, Date.now() - 2 * DAY_MS);
    const server = serveChatService(stockChatService(env), env);
    try {
      await once(server, 'listening');
      await vi.waitFor(async () => expect([existsSync(retired), await store.pendingFilesCleanup()]).toEqual([false, []]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });

  it('refuses a scheduled run for a missing account, or one whose deletion is pending', async () => {
    const env = { BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE };
    const documents = memoryDocuments();
    const service = stockChatService(env, { accountStore: stockAccountStore(env, documents) })(history);
    const route = new Hono().route('/', service.routes);
    const { accountId } = await (await route.request('/account/session')).json() as { accountId: string };

    expect(await service.scheduledRequester(accountId)).toEqual({ owner: accountId, anonymous: true });
    await expect(service.scheduledRequester('acct_missing')).rejects.toThrow('Scheduled run for a missing BotCube account acct_missing');
    const pending = await documents.send(new GetCommand({ TableName: 'chat', Key: { pk: `ACCOUNT#${accountId}`, sk: 'META' } }));
    await documents.send(new PutCommand({ TableName: 'chat', Item: { ...pending.Item, record: { ...pending.Item?.record, deletionOperationId: 'op-1' } } }));
    await expect(service.scheduledRequester(accountId)).rejects.toMatchObject({ status: 409, detail: 'Account deletion is pending' });
  });

  it("revokes an expired Guest's credentials and erases the Guest at the next sweep", async () => {
    try {
      const { accountId, table, endpoint } = await expiredGuest();
      const restarted = await guestService(table, endpoint);
      try {
        // Expiry records the intent and the sweep completes it after the erase, so wait for both to show.
        await vi.waitFor(async () => expect([await restarted.store.loadAccount(accountId), await restarted.store.pendingAccountDeletions()]).toEqual([null, []]));
        expect(vault.has(accountId)).toBe(false);
      } finally {
        await restarted.close();
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('keeps an expired Guest pending when its revoke fails, and erases it at the sweep after', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { accountId, table, endpoint } = await expiredGuest();
      refusing.add(accountId);
      const refused = await guestService(table, endpoint);
      try {
        await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(
          'Account deletion failed; it remains pending', accountId, expect.objectContaining({ status: 503 }),
        ));
        expect(vault.has(accountId)).toBe(true);
        expect(await refused.store.loadAccount(accountId)).toMatchObject({ status: 'anonymous' });
        expect(await refused.store.pendingAccountDeletions()).toEqual([expect.objectContaining({ accountId })]);
      } finally {
        await refused.close();
      }

      refusing.delete(accountId);
      const retried = await guestService(table, endpoint);
      try {
        await vi.waitFor(async () => expect(await retried.store.loadAccount(accountId)).toBeNull());
        expect(vault.has(accountId)).toBe(false);
      } finally {
        await retried.close();
      }
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});

describe('a signed-in User deleting their own account', () => {
  const ENTERPRISE = fileURLToPath(new URL('../../examples/enterprise/deployment-config.json', import.meta.url));
  const EXAMPLE_BOT = fileURLToPath(new URL('../../examples/bot/bot.json', import.meta.url));
  const UI = 'http://localhost:3001/';
  const INTROSPECTION_SECRET = 'stand-in-invocation-secret';
  let issuer: StandInOidcIssuer;
  let config: string;
  beforeAll(async () => {
    issuer = await new StandInOidcIssuer().listen();
    const enterprise = JSON.parse(readFileSync(ENTERPRISE, 'utf8')) as { identity: Record<string, unknown> };
    config = join(mkdtempSync(join(tmpdir(), 'stock-oidc-')), 'deployment-config.json');
    writeFileSync(config, JSON.stringify({ bot: EXAMPLE_BOT, identity: { ...enterprise.identity, issuer: issuer.url } }));
  });
  afterAll(async () => { await issuer.close(); });

  async function oidcService(table: string, endpoint: string) {
    const env = {
      PORT: '0', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: endpoint, AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      BOTCUBE_CHAT_TABLE: table, BOTCUBE_DEPLOYMENT_CONFIG: config, BOTCUBE_OIDC_CLIENT_SECRET: 'stand-in-client-secret',
      BOTCUBE_CREDENTIAL_INVOCATION_SECRET: INTROSPECTION_SECRET,
    };
    const server = serveChatService(stockChatService(env), env);
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, store: stockAccountStore(env), browser: () => new Browser(url), close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  type OidcService = Awaited<ReturnType<typeof oidcService>>;

  /** Run `test` against a stock Chat Service on its own table; `restart` starts another on the same table. */
  async function withService(test: (service: OidcService, restart: () => Promise<OidcService>) => Promise<void>) {
    const endpoint = motoEndpoint();
    const table = `stock-self-delete-${Math.random().toString(36).slice(2)}`;
    await createChatTable(endpoint, table);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoint);
    const running: OidcService[] = [];
    const start = async () => {
      const service = await oidcService(table, endpoint);
      running.push(service);
      return service;
    };
    try {
      await test(await start(), start);
    } finally {
      await Promise.all(running.map((service) => service.close()));
      vi.unstubAllEnvs();
    }
  }

  /** Follow the provider's redirect, signed in there as `user`, back to the Chat Service's callback. */
  async function throughProvider(browser: Browser, authorize: URL, user: string): Promise<Response> {
    authorize.searchParams.set('login_hint', user);
    const back = new URL((await fetch(authorize, { redirect: 'manual' })).headers.get('location') ?? '');
    return browser.get(back.pathname + back.search);
  }

  async function signIn(browser: Browser, user: string) {
    const login = await browser.get(`/auth/oidc/login?return_to=${encodeURIComponent(UI)}`);
    expect((await throughProvider(browser, new URL(login.headers.get('location') ?? ''), user)).status).toBe(302);
    return browser.openAccountSession();
  }

  it("answers a product service's Token Introspection of a signed-in User's session, and refuses an unsigned caller", async () => {
    await withService(async (service) => {
      const browser = service.browser();
      const { accountId } = await signIn(browser, 'ada');
      const token = browser.cookies.get('template_session') ?? '';
      const introspect = (caller: string) => fetch(new URL('/oauth/introspect', service.url), {
        method: 'POST', headers: { authorization: `Bearer ${caller}` }, body: new URLSearchParams({ token }),
      });

      const answer = await introspect(signCredentialServiceInvocation(INTROSPECTION_SECRET, 'introspector', 'gateway', { scope: 'token_introspection' }));

      expect([answer.status, await answer.json()]).toEqual([200, { active: true, sub: accountId, exp: expect.any(Number) }]);
      expect((await introspect('not-signed')).status).toBe(401);
    });
  });

  async function startDeletion(browser: Browser): Promise<URL> {
    const response = await browser.post(`/auth/oidc/delete?return_to=${encodeURIComponent(UI)}`, {});
    expect(response.status).toBe(200);
    return new URL(((await response.json()) as { authorizeUrl: string }).authorizeUrl);
  }

  it('sends the User to sign in again at the provider, whatever session it already holds', async () => {
    await withService(async (service) => {
      const browser = service.browser();
      await signIn(browser, 'ada');

      const authorize = await startDeletion(browser);

      expect(authorize.origin).toBe(issuer.url);
      expect(authorize.searchParams.get('prompt')).toBe('login');
      expect(authorize.searchParams.get('max_age')).toBe('0');
    });
  });

  it('records the deletion once the User has just signed in again, signs the browser out, and the next sweep erases the account', async () => {
    await withService(async (service, restart) => {
      const browser = service.browser();
      const { accountId } = await signIn(browser, 'ada');

      const back = await throughProvider(browser, await startDeletion(browser), 'ada');

      expect([back.status, back.headers.get('location')]).toEqual([302, UI]);
      expect(back.headers.getSetCookie()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^template_account_id=; Max-Age=0;/),
        expect.stringMatching(/^template_session=; Max-Age=0;/),
      ]));
      expect(await service.store.pendingAccountDeletions()).toEqual([expect.objectContaining({ accountId })]);
      expect((await browser.request('/threads', { method: 'POST' })).status).toBe(401);
      const swept = await restart();
      // The sweep completes the intent after the erase, so wait on that last write.
      await vi.waitFor(async () => expect(await swept.store.pendingAccountDeletions()).toEqual([]));
      expect(await swept.store.loadAccount(accountId)).toBeNull();
    });
  });

  const MINUTE_SECONDS = 60;
  it.each([
    ['signed in again as someone else', 'linus', undefined, 403, 'The provider signed in someone other than this account; nothing was deleted'],
    ['last authenticated over five minutes ago', 'ada', -6 * MINUTE_SECONDS, 401, expect.stringContaining('auth_time')],
    ['not saying when they authenticated', 'ada', null, 401, expect.stringContaining('auth_time')],
  ])('refuses a deletion from a User %s, recording nothing', async (_, user, authenticatedAgo, status, detail) => {
    await withService(async (service) => {
      const browser = service.browser();
      const { accountId } = await signIn(browser, 'ada');
      if (authenticatedAgo === null) issuer.authenticatedAt.set(user, undefined);
      else if (authenticatedAgo !== undefined) issuer.authenticatedAt.set(user, Math.floor(Date.now() / 1000) + authenticatedAgo);
      try {
        const back = await throughProvider(browser, await startDeletion(browser), user);

        expect([back.status, await back.json()]).toEqual([status, { detail }]);
        expect(await service.store.pendingAccountDeletions()).toEqual([]);
        expect(await service.store.loadAccount(accountId)).toMatchObject({ status: 'registered' });
        expect(await service.store.loadAccount(accountId)).not.toHaveProperty('deletionOperationId');
      } finally {
        issuer.authenticatedAt.delete(user);
      }
    });
  });
});
