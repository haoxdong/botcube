import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { DeleteTableCommand, DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { Hono } from 'hono';
import * as scheduledRuns from './scheduled-runs.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeAgentCore } from '../test/fakes/fake-agentcore.js';
import { FakeBedrock, FakeSessionApi } from '../test/fakes/fake-backends.js';
import { HttpFake } from '../test/fakes/http-fake.js';
import { RUNTIME_ARN, createChatTable } from '../test/fakes/stack.js';
import { dispatcherFetch } from './dispatcher-fetch.js';
import { serveChatService } from './server.js';
import type { StockOverrides } from './stock.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { reportUnsavedTurnSummaries } from './turn-summaries.js';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';
import { credentialSource } from './credential-source.js';
import { testBotCubeConfig } from '../test/stock-bot.js';

vi.mock('./dispatcher-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatcher-fetch.js')>();
  return { dispatcherFetch: vi.fn(actual.dispatcherFetch) };
});

const CONFIG = testBotCubeConfig();

const overrides: StockOverrides = {
  agentDocuments: { agentIdentity: { name: 'Test Bot', character: '', vibe: '', avatar: '' }, soul: '' },
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  accountModels: async () => [], accountModel: async () => undefined,
  routes: new Hono(),
  requester: async () => ({ owner: 'account-1' }),
  filingUserId: (owner) => `filed-${owner}`,
  scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null,
  invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps } }),
  credentialProps: [],
  authorizeBrowserLiveView: async () => undefined,
  warmSession: async () => undefined,
  turnStarting: () => undefined, recoverAccountDeletions: async () => undefined, browserLiveView: async () => null,
};

// Each finished Turn is summarized after its stream ends, so the summary model outlives every test.
const bedrock = new FakeBedrock();
beforeAll(() => bedrock.listen());
afterAll(() => bedrock.close());

const closers: (() => Promise<void>)[] = [];
const tableClosers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(tableClosers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fake<T extends HttpFake>(server: T): Promise<T> {
  await server.listen();
  closers.push(() => server.close());
  return server;
}

async function newTable(name = `chat-${Math.random().toString(36).slice(2)}`): Promise<string> {
  const endpoint = motoEndpoint();
  await createChatTable(endpoint, name);
  tableClosers.push(async () => {
    const client = new DynamoDBClient(motoAws());
    try {
      await client.send(new DeleteTableCommand({ TableName: name }));
    } finally {
      client.destroy();
    }
  });
  return name;
}

async function allocatedTable(sessionId: string): Promise<string> {
  const table = await newTable();
  const client = new DynamoDBClient(motoAws());
  try {
    await new DynamoDBSessionMetadata(table, client).recordTurn('account-1', sessionId, { filingUserId: 'filed-account-1', title: '', warmup: true, allocation: true });
  } finally {
    client.destroy();
  }
  return table;
}

/** Serve the Chat Service from this environment, as its entry point does; answers its base URL. */
async function serve(env: NodeJS.ProcessEnv): Promise<string> {
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', motoEndpoint());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const server: ServerType = serveChatService({ BOTCUBE_CONFIG: CONFIG, AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url, ...env }, { overrides });
  closers.push(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const turn = (threadId: string) =>
  JSON.stringify({
    threadId,
    runId: 'run-1',
    state: {},
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    forwardedProps: {},
  });

const postTurn = (url: string, threadId: string) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: turn(threadId) });

describe('the Chat Service served from the environment', () => {
  it('aborts a blocked scheduled-run receive when the HTTP server closes', async () => {
    let receiveSignal: (signal: AbortSignal) => void;
    const received = new Promise<AbortSignal>((resolve) => { receiveSignal = resolve; });
    vi.spyOn(scheduledRuns, 'sqsRunQueue').mockReturnValue({
      receive: (signal) => {
        receiveSignal(signal);
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
        });
      },
      delete: async () => undefined,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', motoEndpoint());
    const server = serveChatService({
      PORT: '0', BOTCUBE_CONFIG: CONFIG, BOTCUBE_CHAT_TABLE: await newTable(),
      BOTCUBE_SCHEDULE_GROUP: 'test-group',
      BOTCUBE_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
      BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:runs',
      BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/runs',
    }, { overrides });
    closers.push(async () => {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    });
    await once(server, 'listening');
    const signal = await received;
    expect(signal.aborted).toBe(false);

    await new Promise((resolve) => server.close(resolve));

    expect(signal.aborted).toBe(true);
  });

  describe('stops at startup, naming the seam and the source, on a credential it cannot read', () => {
    const absent = `/nonexistent/botcube-${Math.random().toString(36).slice(2)}`;
    async function exitsWith(botOverrides: StockOverrides, env: NodeJS.ProcessEnv): Promise<string> {
      const failed = new Promise<string>((resolve) => {
        vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
          if (String(message).startsWith('The Chat Service could not read a credential at startup')) resolve(String(message));
        });
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', motoEndpoint());
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const server = serveChatService({ PORT: '0', BOTCUBE_CONFIG: CONFIG, BOTCUBE_CHAT_TABLE: await newTable(), ...env }, { overrides: botOverrides });
      closers.push(async () => {
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      });
      const message = await failed;
      expect(exit).toHaveBeenCalledWith(1);
      return message;
    }

    it("the models Endpoint's", async () => {
      const models = { kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: { kind: 'file', path: absent }, turnSummaryModel: 'example-summary' };
      const env = { BOTCUBE_CONFIG: testBotCubeConfig(undefined, { integrations: { modelGateway: models } }) };
      expect(await exitsWith(overrides, env)).toContain(`models credential (file ${absent}): ENOENT`);
    });

    it("the bot's own, such as sign-in's client secret", async () => {
      const startupCredentials = [credentialSource('identity.clients.0.clientSecret', { kind: 'file', path: absent })];
      expect(await exitsWith({ ...overrides, startupCredentials }, {})).toContain(`identity.clients.0.clientSecret credential (file ${absent}): ENOENT`);
    });
  });

  it('listens on $PORT and says so', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    expect(console.log).toHaveBeenCalledWith(`Chat Service listening on :0`);
    expect((await fetch(`${url}/ping`)).status).toBe(200);
  });

  // A Turn's summary runs on after its stream closed, so a task stopping meanwhile alarms on it.
  it('raises the Turn-summary alarm, as it exits, for each summary it has not saved', async () => {
    await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    expect(process.listeners('exit')).toContain(reportUnsavedTurnSummaries);
  });

  it('answers Live wake requests after the parked Worker hands over', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });
    const responses = await Promise.all(['GET', 'POST'].map((method) => fetch(`${url}/production/wake`, { method })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.headers.get('Cache-Control'))).toEqual(['no-store', 'no-store']);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ state: 'live' }, { state: 'live' }]);
  });

  it('refuses to report Live while Session Metadata is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: `missing-${Math.random().toString(36).slice(2)}` });
    const responses = await Promise.all(['GET', 'POST'].map((method) => fetch(`${url}/production/wake`, { method })));
    expect(responses.map((response) => response.status)).toEqual([503, 503]);
  });

  it('keeps Session Metadata in BOTCUBE_CHAT_TABLE', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('reports production activity to BOTCUBE_CHAT_TABLE for the parking Lambda', async () => {
    const table = await newTable();
    await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: table });
    const client = new DynamoDBClient(motoAws());
    try {
      await vi.waitFor(async () => {
        const { Items = [] } = await client.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
          ExpressionAttributeValues: { ':pk': { S: 'PRODUCTION_PARKING' }, ':sk': { S: 'ACTIVITY#' } },
        }));
        expect(Items).toHaveLength(1);
      });
    } finally {
      client.destroy();
    }
  });

  it.each([1, 2])('keeps Session Metadata in the "chat" table by default on fixture run %i', async () => {
    await newTable('chat');
    const url = await serve({ PORT: '0' });

    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('rejects creating a fixture table that already exists', async () => {
    const table = await newTable();

    await expect(newTable(table)).rejects.toThrow('ResourceInUseException');
  });

  it('sends Turns and warmups to the AgentCore Runtime AGENTCORE_RUNTIME_ARN names', async () => {
    const agentcore = await fake(new FakeAgentCore());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await allocatedTable('env-turn'),
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: `${agentcore.url}/`,
    });

    expect((await postTurn(url, 'env-turn')).status).toBe(200);
    expect(await (await fetch(`${url}/warmup`, { method: 'POST' })).json()).toEqual({ status: 'ok' });
    expect(agentcore.invocations().map(({ path }) => path)).toEqual([
      `/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`,
      `/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`,
    ]);
  });

  it('summarizes each finished Turn with Claude Haiku 4.5', async () => {
    const agentcore = await fake(new FakeAgentCore());
    const env = { PORT: '0', AGENTCORE_RUNTIME_ARN: RUNTIME_ARN, AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url };
    const summaryModel = await fake(new FakeBedrock());
    const summarized = () => summaryModel.requests.map(({ path }) => path);

    const url = await serve({ ...env, BOTCUBE_CHAT_TABLE: await allocatedTable('env-default-model'), AWS_ENDPOINT_URL_BEDROCK_RUNTIME: summaryModel.url });

    await (await postTurn(url, 'env-default-model')).text();

    await expect.poll(() => summarized()).toEqual([
      `/model/${encodeURIComponent('us.anthropic.claude-haiku-4-5-20251001-v1:0')}/converse`,
    ]);
  });

  it('sends Turns to BOTCUBE_LOCAL_HARNESS_URL instead of AgentCore when it is set', async () => {
    const local = await fake(
      new HttpFake((_, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"RUN_FINISHED"}\n\n');
      }),
    );
    const agentcore = await fake(new FakeAgentCore());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await allocatedTable('env-local'),
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
      BOTCUBE_LOCAL_HARNESS_URL: `${local.url}//`,
    });

    expect(await (await postTurn(url, 'env-local')).text()).toBe('data: {"type":"RUN_FINISHED"}\n\n');
    expect(local.requests.map(({ path }) => path)).toEqual(['/invocations']);
    expect(agentcore.invocations()).toEqual([]);
  });

  it('answers Turns with 503 and skips warmup, with a warning, when no Harness is configured', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    expect((await postTurn(url, 'env-unconfigured')).status).toBe(503);
    expect(await (await fetch(`${url}/warmup`, { method: 'POST' })).json()).toMatchObject({ status: 'skipped' });
    expect(consoleWarn.mock.calls).toEqual([
      ['AGENTCORE_RUNTIME_ARN is not set; agent runs (POST /) return 503 and warmup is skipped until it is configured.'],
    ]);
  });

  it('does not warn when only a local Harness is configured', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable(), BOTCUBE_LOCAL_HARNESS_URL: 'http://127.0.0.1:1' });

    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('does not warn when an AgentCore Runtime is configured', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable(), AGENTCORE_RUNTIME_ARN: RUNTIME_ARN });

    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("allows the BotCube Config's web origin and its aliases in place of the local web UI", async () => {
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
      BOTCUBE_CONFIG: testBotCubeConfig(undefined, { domains: { web: 'https://a.example.com', webAliases: ['https://b.example.com'], chatService: 'https://api.example.com' } }),
    });
    const allowed = async (origin: string) =>
      (await fetch(`${url}/ping`, { headers: { origin } })).headers.get('access-control-allow-origin');

    expect(await allowed('https://a.example.com')).toBe('https://a.example.com');
    expect(await allowed('https://b.example.com')).toBe('https://b.example.com');
    expect(await allowed('http://localhost:3001')).toBeNull();
    expect(await allowed('')).toBeNull();
  });

  it('allows the local web UI when the BotCube Config names no web origin', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    const response = await fetch(`${url}/ping`, { headers: { origin: 'http://localhost:3001' } });

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3001');
  });

  it('presigns live views of the AGENTCORE_BROWSER_ID browser in AWS_REGION', async () => {
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
      AWS_REGION: 'eu-west-1',
      AGENTCORE_BROWSER_ID: 'custom-browser',
    });

    const { signedUrl } = await (await fetch(`${url}/browser-live-view-url?session_id=S-1`)).json();

    const signed = new URL(signedUrl);
    expect(`${signed.origin}${signed.pathname}`).toBe(
      'https://bedrock-agentcore.eu-west-1.amazonaws.com/browser-streams/custom-browser/sessions/S-1/live-view',
    );
    expect(signed.searchParams.get('X-Amz-Credential')).toMatch(/\/eu-west-1\/bedrock-agentcore\/aws4_request$/);
  });

  it('presigns live views of the AWS system browser by default', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    const { signedUrl } = await (await fetch(`${url}/browser-live-view-url?session_id=S-1`)).json();

    expect(new URL(signedUrl).pathname).toBe('/browser-streams/aws.browser.v1/sessions/S-1/live-view');
  });

  it('reads Sessions from BOTCUBE_LOCAL_SESSION_API_URL', async () => {
    const sessionApi = await fake(new FakeSessionApi());
    const agentcore = await fake(new FakeAgentCore());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await allocatedTable('env-replayed'),
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
      BOTCUBE_LOCAL_SESSION_API_URL: `${sessionApi.url}//`,
    });
    await (await postTurn(url, 'env-replayed')).text();

    expect((await fetch(`${url}/threads/env-replayed`)).status).toBe(200);
    expect(sessionApi.requests.map(({ path }) => path)).toEqual(['/invocations']);
  });

  it('invokes the BOTCUBE_SESSION_API_FUNCTION_ARN function in AWS_REGION, over a local session API', async () => {
    const lambdaCalls: string[] = [];
    const transport = vi.mocked(dispatcherFetch);
    const { dispatcherFetch: passThrough } = await vi.importActual<typeof import('./dispatcher-fetch.js')>('./dispatcher-fetch.js');
    transport.mockImplementation(async (target, init) => {
      if (!target.startsWith('https://lambda.')) return passThrough(target, init);
      lambdaCalls.push(target);
      return Response.json({ statusCode: 200, body: { messages: [] } });
    });
    const agentcore = await fake(new FakeAgentCore());
    const sessionApi = await fake(new FakeSessionApi());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await allocatedTable('env-function'),
      AWS_REGION: 'eu-west-1',
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
      BOTCUBE_SESSION_API_FUNCTION_ARN: 'arn:aws:lambda:eu-west-1:123456789012:function:session-api',
      BOTCUBE_LOCAL_SESSION_API_URL: sessionApi.url,
    });
    await (await postTurn(url, 'env-function')).text();

    expect((await fetch(`${url}/threads/env-function`)).status).toBe(200);
    expect(lambdaCalls).toEqual([
      'https://lambda.eu-west-1.amazonaws.com/2015-03-31/functions/arn%3Aaws%3Alambda%3Aeu-west-1%3A123456789012%3Afunction%3Asession-api/invocations',
    ]);
    expect(sessionApi.requests).toEqual([]);
  });

  it('answers 503 for a Session read without a session API', async () => {
    const agentcore = await fake(new FakeAgentCore());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await allocatedTable('env-no-session-api'),
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
    });
    await (await postTurn(url, 'env-no-session-api')).text();

    const response = await fetch(`${url}/threads/env-no-session-api`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'The session API is not configured' });
  });
});
