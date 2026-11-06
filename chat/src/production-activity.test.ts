import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { isUserRequest, PARKING_PARTITION, ProductionActivity, SILENT_TURN_MS } from './production-activity.js';
import { MAX_RUNNING_TURN_AGE_MS } from './sessions.js';

const web = ['https://bot.example.com'];
const automation = ['-Verification/', 'example-probe', 'example-automation'];
const request = (path: string, headers: Record<string, string>) => new Request(`https://api.example.com${path}`, { headers });

describe('a user request', () => {
  it('is one the web UI sends for a person', () => {
    expect(isUserRequest(request('/threads', { origin: 'https://bot.example.com' }), web, automation)).toBe(true);
  });

  it.each([
    ['a health check', '/health', { origin: 'https://bot.example.com' }],
    ['a ping', '/ping', { origin: 'https://bot.example.com' }],
    ['an OIDC discovery fetch', '/.well-known/jwks.json', { origin: 'https://bot.example.com' }],
    ['a probe with no Origin', '/v1/users/self', { 'user-agent': 'curl/8.5.0' }],
    ['another site', '/threads', { origin: 'https://example.com' }],
    ['a Test User', '/threads', { origin: 'https://bot.example.com', 'x-botcube-test-user': 'test_bearer' }],
    ['a deploy verifier', '/', { origin: 'https://bot.example.com', 'user-agent': 'BotCube-Preview-Verification/1.0' }],
    ['a credential probe', '/v1/users/self', { origin: 'https://bot.example.com', 'user-agent': 'example-probe' }],
    ['a census in a real browser', '/threads', { origin: 'https://bot.example.com', 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1 example-automation' }],
  ])('is not %s', (_caller, path, headers) => {
    expect(isUserRequest(request(path, headers), web, automation)).toBe(false);
  });
});

describe('production activity', () => {
  let stack: InProcessStack | undefined;
  afterEach(async () => { await stack?.stop(); });

  it('reports a Turn running from its mark to its end, and none once it ends', async () => {
    const activity = new ProductionActivity();
    stack = await startInProcess({ activity });
    const during: number[] = [];
    stack.agentcore.scriptPrompt('Brief me', { kind: 'stream', frames: () => {
      during.push(activity.heartbeat().runningTurns);
      return [{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', role: 'assistant', delta: 'Brief.' }, { type: 'RUN_FINISHED' }]
        .map((frame) => `data: ${JSON.stringify(frame)}`);
    } });

    await stack.allocate('activity-owner', 'activity-chat');
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'activity-owner' },
      body: JSON.stringify({ threadId: 'activity-chat', runId: 'activity-run', state: {}, messages: [{ id: 'm1', role: 'user', content: 'Brief me' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(during).toEqual([1]);
    await vi.waitFor(() => expect(activity.heartbeat().runningTurns).toBe(0));
  });

  it('stops counting a Turn whose client left before its response began, through the Node adapter', async () => {
    const activity = new ProductionActivity();
    stack = await startInProcess({ activity });
    const ran: number[] = [];
    stack.agentcore.scriptPrompt('Hello', { kind: 'stream', frames: () => {
      ran.push(activity.heartbeat().runningTurns);
      return [{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', role: 'assistant', delta: 'Hey.' }, { type: 'RUN_FINISHED' }]
        .map((frame) => `data: ${JSON.stringify(frame)}`);
    } });
    await stack.allocate('abandon-owner', 'abandon-chat');
    const { app } = stack;
    let arrived!: () => void;
    const received = new Promise<void>((resolve) => { arrived = resolve; });
    const fetch = async (request: Request) => {
      const body = await request.arrayBuffer();
      arrived();
      await new Promise((resolve) => { request.signal.addEventListener('abort', resolve, { once: true }); });
      return app.fetch(new Request(request, { body }));
    };
    const server = await new Promise<ServerType>((resolve) => { const started = serve({ fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started)); });
    try {
      const { port } = server.address() as AddressInfo;
      const client = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'x-test-owner': 'abandon-owner' } });
      client.on('error', () => undefined);
      client.end(JSON.stringify({ threadId: 'abandon-chat', runId: 'abandon-run', state: {}, messages: [{ id: 'm1', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: { model: 'quick' } }));
      await received;
      client.destroy();

      await vi.waitFor(() => expect(ran).toEqual([1]));
      await vi.waitFor(() => expect(activity.heartbeat()).toMatchObject({ runningTurns: 0, runningTurnIds: [] }));
      await vi.waitFor(async () => expect((await defined(stack, 'the stack').sessionMetadata.get('abandon-owner', 'abandon-chat'))?.turn_running_since).toBeUndefined());
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  it('starts the idle clock when the task starts, moves it on a user request, and forgets a Turn marked an hour ago', () => {
    let now = 1_000;
    const activity = new ProductionActivity(() => now);
    activity.turnStarted('owner#chat', 'lost-run');
    expect(activity.heartbeat()).toMatchObject({ pk: PARKING_PARTITION, at: 1_000, lastUserRequestAt: 1_000, runningTurns: 1 });

    now += MAX_RUNNING_TURN_AGE_MS;
    activity.turnActive('owner#chat', 'lost-run');
    activity.userRequest();

    expect(activity.heartbeat()).toMatchObject({ at: now, lastUserRequestAt: now, runningTurns: 0 });
  });

  it('leaves a scheduled run, which reads its answer at once, to the hour cap', () => {
    let now = 1_000;
    const activity = new ProductionActivity(() => now);
    activity.turnStarted('owner#side-chat', 'scheduled-run', false);
    now += SILENT_TURN_MS * 5;
    expect(activity.heartbeat()).toMatchObject({ runningTurns: 1, runningTurnIds: ['side-chat/scheduled-run'] });
  });

  it('names the Turns it counts, keeps one its Harness still sends to, and drops one silent for ten minutes, with a log', () => {
    let now = 1_000;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const activity = new ProductionActivity(() => now);
    activity.turnStarted('owner#busy-chat', 'busy-run');
    activity.turnStarted('owner#abandoned-chat', 'abandoned-run');
    expect(activity.heartbeat()).toMatchObject({ runningTurns: 2, runningTurnIds: ['busy-chat/busy-run', 'abandoned-chat/abandoned-run'] });

    now += SILENT_TURN_MS - 1;
    activity.turnActive('owner#busy-chat', 'busy-run');
    expect(activity.heartbeat()).toMatchObject({ runningTurns: 2 });
    now += 1;
    expect(activity.heartbeat()).toMatchObject({ runningTurns: 1, runningTurnIds: ['busy-chat/busy-run'] });
    expect(warn).toHaveBeenCalledWith('Production activity stopped counting Turn abandoned-chat/abandoned-run as running: its Harness sent nothing for 10 min');
    warn.mockRestore();
  });

  it('writes its heartbeat to the chat table for the parking Lambda', async () => {
    stack = await startInProcess();
    const activity = new ProductionActivity(() => 42);
    const documents = DynamoDBDocumentClient.from(stack.table.client);
    const stop = activity.report(stack.table.name, documents);
    try {
      await vi.waitFor(async () => expect((await documents.send(new GetCommand({
        TableName: defined(stack, 'the stack').table.name, Key: { pk: PARKING_PARTITION, sk: `ACTIVITY#${activity.instance}` },
      }))).Item).toEqual({ pk: PARKING_PARTITION, sk: `ACTIVITY#${activity.instance}`, at: 42, lastUserRequestAt: 42, runningTurns: 0, runningTurnIds: [] }));
    } finally {
      stop();
    }
  });
});
