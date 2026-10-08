import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './cartridge.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

let stack: InProcessStack;
const authorized: string[] = [];
beforeAll(async () => {
  stack = await startInProcess({
    cartridge: {
      authorizeBrowserLiveView: async (sessionId) => {
        if (sessionId === 'not-yours') throw new HttpError(403, 'Not your browser Session');
        authorized.push(sessionId);
      },
    },
    config: { region: 'us-west-2', agentCoreEndpoint: 'https://agentcore.example.com', browserId: "browser!'()*" },
  });
});
afterAll(() => stack.stop());
afterEach(() => vi.restoreAllMocks());

describe('GET /health', () => {
  it('is ok when Session Metadata storage is reachable', async () => {
    const response = await stack.app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is 503 when the Session Metadata table is missing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bare = await startInProcess({ table: 'missing' });
    try {
      const response = await bare.app.request('/health');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ detail: 'Session Metadata storage is unavailable' });
      expect(consoleError.mock.calls).toEqual([
        ['Session Metadata readiness probe failed', expect.objectContaining({ name: 'ResourceNotFoundException' })],
      ]);
    } finally {
      await bare.stop();
    }
  });
});

describe('GET /agent', () => {
  it("names the Cartridge's agent and reports it online with a Runtime", async () => {
    const response = await stack.app.request('/agent');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Test Bot', avatar: '', picture: null, status: 'online' });
  });

  it('reports the agent offline without a Runtime or local Harness', async () => {
    const bare = await startInProcess({ config: { agentCore: null } });
    try {
      expect(await (await bare.app.request('/agent')).json()).toEqual({ name: 'Test Bot', avatar: '', picture: null, status: 'offline' });
    } finally {
      await bare.stop();
    }
  });
});

it('GET /ping is healthy', async () => {
  const response = await stack.app.request('/ping');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'Healthy' });
});

it('reports failed scheduled polling as unavailable through both health endpoints', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new Error('ECS DescribeTasks is unreachable');
  const failed = await startInProcess({ scheduled: true, scheduledDraining: async () => { throw failure; } });
  try {
    const responses = await Promise.all(['/health', '/ping'].map((path) => failed.app.request(path)));
    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { detail: 'Scheduled runs are unavailable' },
      { detail: 'Scheduled runs are unavailable' },
    ]);
  } finally {
    await failed.stop();
  }
});

describe('GET /browser-live-view-url', () => {
  it("presigns the browser Session's live view for five minutes, each path segment percent-encoded", async () => {
    const response = await stack.app.request('/browser-live-view-url?session_id=S%201%2Fa*');

    expect(response.status).toBe(200);
    const signed = new URL(((await response.json()) as { signedUrl: string }).signedUrl);
    expect(`${signed.origin}${signed.pathname}`).toBe(
      'https://agentcore.example.com/browser-streams/browser%21%27%28%29%2A/sessions/S%201%2Fa%2A/live-view',
    );
    expect(signed.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAPARITYSUITE\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request$/);
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(authorized).toContain('S 1/a*');
  });

  it('answers 422 without a session_id', async () => {
    const response = await stack.app.request('/browser-live-view-url');

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: [{ type: 'missing', loc: ['query', 'session_id'], msg: 'Field required' }],
    });
  });

  it('answers 422 for a blank session_id', async () => {
    const response = await stack.app.request('/browser-live-view-url?session_id=%20');

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'session_id must not be blank' });
  });

  it('answers the Cartridge refusal for a browser Session the request may not watch', async () => {
    const response = await stack.app.request('/browser-live-view-url?session_id=not-yours');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Not your browser Session' });
  });
});

describe('a request that fails', () => {
  it('with an HttpError answers its status and detail', async () => {
    const refusing = await startInProcess({
      cartridge: {
        requester: async () => {
          throw new HttpError(401, 'Missing account cookie');
        },
      },
    });
    try {
      const response = await refusing.app.request('/threads');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ detail: 'Missing account cookie' });
    } finally {
      await refusing.stop();
    }
  });

  it('with any other error answers 500 and logs it', async () => {
    const failure = new Error('boom');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = await startInProcess({
      cartridge: {
        requester: async () => {
          throw failure;
        },
      },
    });
    try {
      const response = await broken.app.request('/threads/session-1', { method: 'DELETE' });

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(consoleError.mock.calls).toEqual([['DELETE /threads/session-1 failed', failure]]);
    } finally {
      await broken.stop();
    }
  });
});

describe('Account History Session ownership', () => {
  it.each(['DELETED', 'CLAIM'])('denies a started Main Chat while its owner has a %s fence', async (fence) => {
    const isolated = await startInProcess();
    try {
      const owner = 'account-1';
      const sessionId = await isolated.sessionMetadata.mainChat(owner);
      await isolated.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'filed-account-1', title: 'Main Chat' });
      await isolated.sessionMetadata.recordTurn(owner, 'ordinary-turn', { filingUserId: 'filed-account-1', title: 'Ordinary Turn' });
      expect(await isolated.history.owns(owner, sessionId)).toBe(true);
      expect(await isolated.history.owns(owner, 'ordinary-turn')).toBe(true);
      await DynamoDBDocumentClient.from(isolated.table.client).send(new PutCommand({
        TableName: isolated.table.name,
        Item: { pk: `SESSIONS#${owner}`, sk: fence, destination: 'claimed-account', deleted_at: '2026-10-07T00:00:00Z' },
      }));
      expect(await isolated.history.ownsMainChat(owner, sessionId)).toBe(false);
      expect(await isolated.history.owns(owner, sessionId)).toBe(false);
      expect(await isolated.history.owns(owner, 'ordinary-turn')).toBe(false);
    } finally {
      await isolated.stop();
    }
  });
});

it('records first-answer attribution receipt, admission and actual dispatch around native preparation', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const target = await startInProcess({ cartridge: {
    requester: async () => { now = 120; return { owner: 'account-1' }; },
    invocationPayload: async (input) => { now = 190; return { ...input, forwardedProps: { ...input.forwardedProps } }; },
  } });
  const record = target.sessionMetadata.recordTurn.bind(target.sessionMetadata);
  vi.spyOn(target.sessionMetadata, 'recordTurn').mockImplementation(async (...args) => {
    const result = await record(...args);
    now = 160;
    return result;
  });
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const runId = '44444444-4444-4444-8444-444444444444';
  target.agentcore.script(sessionId, { kind: 'stream', frames: () => { now = 240; return [
    'data: {"type":"RUN_STARTED"}',
    'data: {"type":"TEXT_MESSAGE_START","messageId":"first","role":"assistant"}',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"first","delta":"private answer"}',
    'data: {"type":"RUN_FINISHED"}',
  ]; } });
  try {
    const response = await target.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId, state: {}, messages: [{ id: 'user', role: 'user', content: 'private prompt' }], tools: [], context: [], forwardedProps: {} }) });
    expect(await response.text()).toContain('private answer');
    const boundary = log.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith('{"event":"chat_first_answer_boundary"'));
    expect(boundary).toBeDefined();
    expect(JSON.parse(boundary ?? '{}')).toMatchObject({ runId, sessionId, publicMessageId: 'first', status: 'complete',
      offsetsMs: { receipt: 0, admissionComplete: 60, invokeDispatch: 90, answerReceived: 140, answerEmitted: 140 } });
    expect(boundary).not.toContain('private');
  } finally { await target.stop(); }
});
