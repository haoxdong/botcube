import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import * as scheduledRuns from './scheduled-runs.js';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { FakeAgentCore } from '../../../tests/chat/fakes/fake-agentcore.js';
import { FakeBedrock, FakeSessionApi } from '../../../tests/chat/fakes/fake-backends.js';
import { HttpFake } from '../../../tests/chat/fakes/http-fake.js';
import { RUNTIME_ARN, createChatTable } from '../../../tests/chat/fakes/stack.js';
import type { ChatServiceCartridge } from './cartridge.js';
import { serveChatService } from './server.js';
import { reportUnsavedTurnSummaries } from './turn-summaries.js';

const cartridge: ChatServiceCartridge = {
  corsOrigins: ['https://cartridge.example.com'],
  agentDocuments: { agentIdentity: { name: 'Test Bot', character: '', vibe: '', avatar: '' }, soul: '' },
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  accountModels: async () => [],
  browserEventName: 'test:browser-live-view',
  routes: new Hono(),
  requester: async () => ({ owner: 'account-1' }),
  filingUserId: (owner) => `filed-${owner}`,
  scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null,
  invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps } }),
  credentialProps: [],
  authorizeBrowserLiveView: async () => undefined,
  warmSession: async () => undefined,
};

// Each finished Turn is summarized after its stream ends, so the summary model outlives every test.
const bedrock = new FakeBedrock();
beforeAll(() => bedrock.listen());
afterAll(() => bedrock.close());

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
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
  await createChatTable(inject('dynamodbEndpoint'), name);
  return name;
}

/** Serve the Chat Service from this environment, as its entry point does; answers its base URL. */
async function serve(env: NodeJS.ProcessEnv): Promise<string> {
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', inject('dynamodbEndpoint'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const server: ServerType = serveChatService(() => cartridge, { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url, ...env });
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
    const server = serveChatService(() => cartridge, {
      PORT: '0',
      BOTCUBE_SCHEDULE_GROUP: 'test-group',
      BOTCUBE_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
      BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:runs',
      BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/runs',
    });
    await once(server, 'listening');
    const signal = await received;
    expect(signal.aborted).toBe(false);

    await new Promise((resolve) => server.close(resolve));

    expect(signal.aborted).toBe(true);
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

  it('keeps Session Metadata in BOTCUBE_CHAT_TABLE', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('keeps Session Metadata in the "chat" table by default', async () => {
    await newTable('chat');
    const url = await serve({ PORT: '0' });

    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('sends Turns and warmups to the AgentCore Runtime AGENTCORE_RUNTIME_ARN names', async () => {
    const agentcore = await fake(new FakeAgentCore());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
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

    const url = await serve({ ...env, BOTCUBE_CHAT_TABLE: await newTable(), AWS_ENDPOINT_URL_BEDROCK_RUNTIME: summaryModel.url });

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
      BOTCUBE_CHAT_TABLE: await newTable(),
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

  it('allows the trimmed BOTCUBE_CORS_ORIGINS in place of the Cartridge defaults', async () => {
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
      BOTCUBE_CORS_ORIGINS: ' https://a.example.com , ,https://b.example.com',
    });
    const allowed = async (origin: string) =>
      (await fetch(`${url}/ping`, { headers: { origin } })).headers.get('access-control-allow-origin');

    expect(await allowed('https://a.example.com')).toBe('https://a.example.com');
    expect(await allowed('https://b.example.com')).toBe('https://b.example.com');
    expect(await allowed('https://cartridge.example.com')).toBeNull();
    expect(await allowed('')).toBeNull();
  });

  it('allows the Cartridge default origins without BOTCUBE_CORS_ORIGINS', async () => {
    const url = await serve({ PORT: '0', BOTCUBE_CHAT_TABLE: await newTable() });

    const response = await fetch(`${url}/ping`, { headers: { origin: 'https://cartridge.example.com' } });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://cartridge.example.com');
  });

  it('presigns live views of the AGENTCORE_BROWSER_ID browser in AGENTCORE_REGION', async () => {
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
      AGENTCORE_REGION: 'eu-west-1',
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
      BOTCUBE_CHAT_TABLE: await newTable(),
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
      BOTCUBE_LOCAL_SESSION_API_URL: `${sessionApi.url}//`,
    });
    await (await postTurn(url, 'env-replayed')).text();

    expect((await fetch(`${url}/threads/env-replayed`)).status).toBe(200);
    expect(sessionApi.requests.map(({ path }) => path)).toEqual(['/invocations']);
  });

  it('invokes the BOTCUBE_SESSION_API_FUNCTION_ARN function in AGENTCORE_REGION, over a local session API', async () => {
    const lambdaCalls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (!target.startsWith('https://lambda.')) return realFetch(input, init);
      lambdaCalls.push(target);
      return Response.json({ statusCode: 200, body: { messages: [] } });
    });
    const agentcore = await fake(new FakeAgentCore());
    const sessionApi = await fake(new FakeSessionApi());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
      AGENTCORE_REGION: 'eu-west-1',
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
      BOTCUBE_SESSION_API_FUNCTION_ARN: 'arn:aws:lambda:eu-west-1:123456789012:function:session-api',
      BOTCUBE_LOCAL_SESSION_API_URL: sessionApi.url,
    });
    await (await postTurn(url, 'env-function')).text();

    expect((await realFetch(`${url}/threads/env-function`)).status).toBe(200);
    expect(lambdaCalls).toEqual([
      'https://lambda.eu-west-1.amazonaws.com/2015-03-31/functions/arn%3Aaws%3Alambda%3Aeu-west-1%3A123456789012%3Afunction%3Asession-api/invocations',
    ]);
    expect(sessionApi.requests).toEqual([]);
  });

  it('answers 503 for a Session read without a session API', async () => {
    const agentcore = await fake(new FakeAgentCore());
    const url = await serve({
      PORT: '0',
      BOTCUBE_CHAT_TABLE: await newTable(),
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcore.url,
    });
    await (await postTurn(url, 'env-no-session-api')).text();

    const response = await fetch(`${url}/threads/env-no-session-api`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'The session API is not configured' });
  });
});
