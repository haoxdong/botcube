import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, expect, it, vi } from 'vitest';
import { serveChatService } from '../src/server.js';
import { fileURLToPath } from 'node:url';
import { FakeAgentCore } from './fakes/fake-agentcore.js';
import { FakeBedrock, FakeSessionApi } from './fakes/fake-backends.js';
import { RUNTIME_ARN, createChatTable } from './fakes/stack.js';
import { motoEndpoint } from './fakes/moto.js';

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  await cleanup.reverse().reduce(async (previous, close) => {
    await previous;
    await close();
  }, Promise.resolve());
});

it('serves the stock Chat Service over HTTP with persisted thread metadata and classified runtime failures', async () => {
  const agent = await new FakeAgentCore().listen();
  const sessions = await new FakeSessionApi().listen();
  const bedrock = await new FakeBedrock().listen();
  cleanup.push(() => agent.close(), () => sessions.close(), () => bedrock.close());
  const endpoint = motoEndpoint();
  const table = `template-smoke-${Math.random().toString(36).slice(2)}`;
  await createChatTable(endpoint, table);
  const env = {
    PORT: '0', AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agent.url,
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url,
    AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
    BOTCUBE_CHAT_TABLE: table,
    BOTCUBE_LOCAL_SESSION_API_URL: sessions.url,
    BOTCUBE_CONFIG: fileURLToPath(new URL('../../infra/local/deployment/botcube.yaml', import.meta.url)),
  };
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoint);
  cleanup.push(async () => {
    vi.unstubAllEnvs();
  });
  const taskStops = process.listenerCount('SIGTERM');
  const server = serveChatService(env);
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(process.listenerCount('SIGTERM')).toBe(taskStops);
  });
  await once(server, 'listening');
  // Stopping the task puts its Agent Computers to sleep.
  expect(process.listenerCount('SIGTERM')).toBe(taskStops + 1);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await fetch(`${url}/health`)).status).toBe(200);
  await Promise.all(['http://localhost:3001', 'http://127.0.0.1:3001'].map(async (origin) => {
    const preflight = await fetch(`${url}/threads`, {
      method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
  }));
  const denied = await fetch(`${url}/threads`, {
    method: 'OPTIONS', headers: { origin: 'https://unrelated.example.invalid', 'access-control-request-method': 'POST' },
  });
  expect(denied.status).toBe(400);
  expect(denied.headers.has('access-control-allow-origin')).toBe(false);
  const account = await fetch(`${url}/account/session`);
  const cookie = account.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Account cookie missing');
  const request = (threadId: string) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ threadId, runId: 'smoke-run', state: {}, messages: [{ id: 'message-1', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
  });
  // The UI allocates each chat before its first Turn.
  const allocate = async () => {
    const created = await fetch(`${url}/threads`, { method: 'POST', headers: { cookie } });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  };
  const threadId = await allocate();
  const response = await request(threadId);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('RUN_FINISHED');
  expect(agent.invocations()).toHaveLength(1);
  const threads = await (await fetch(`${url}/threads`, { headers: { cookie } })).json();
  expect(threads.threads).toEqual(expect.arrayContaining([expect.objectContaining({ id: threadId })]));
  const failedId = await allocate();
  agent.script(failedId, { kind: 'error', status: 503, body: '{"message":"Runtime unavailable"}' });
  const failed = await request(failedId);
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain('Runtime unavailable');
});
