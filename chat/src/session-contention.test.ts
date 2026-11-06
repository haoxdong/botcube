import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../test/fakes/stack.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { relayTurn } from './turn-stream.js';
import { motoEndpoint } from '../test/fakes/moto.js';

const opening = { startedAt: '2026-01-01T00:00:00.000Z', runId: 'opening' };
const queued = { startedAt: '2026-01-01T00:00:01.000Z', runId: 'queued' };
let gateway: HttpFake;
let metadata: DynamoDBSessionMetadata;
let conflict: 'TransactionConflictException' | 'TransactionCanceledException' | 'AccessDeniedException';
let releaseRead: () => void;
let readEntered: Promise<void>;
let failures: number;
let permanent: boolean;
let armed: boolean;
let transaction: boolean;
let conditional: boolean;
let onConflict: (() => Promise<unknown>) | undefined;

beforeEach(async () => {
  failures = 0;
  permanent = false;
  armed = false;
  transaction = false;
  conditional = false;
  onConflict = undefined;
  conflict = 'TransactionConflictException';
  let enterRead!: () => void;
  readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
  const released = new Promise<void>((resolve) => { releaseRead = resolve; });
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(motoEndpoint(), table);
  gateway = await new HttpFake(async (request, response) => {
    const target = String(request.headers['x-amz-target']);
    const read = request.body.includes('SET read_at');
    if (read) {
      enterRead();
      await released;
    } else if (armed && target.endsWith(transaction ? 'TransactWriteItems' : 'UpdateItem') && (permanent || failures === 0)) {
      failures += 1;
      releaseRead();
      await onConflict?.();
      sendJson(response, 400, { __type: conflict, message: 'Transaction is ongoing for the item',
        ...(conflict === 'TransactionCanceledException' ? { CancellationReasons: [{ Code: conditional ? 'ConditionalCheckFailed' : 'None' }, { Code: 'TransactionConflict' }, { Code: 'None' }] } : {}),
      });
      return;
    }
    const upstream = await fetch(motoEndpoint(), {
      method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': target, authorization: String(request.headers.authorization) }, body: request.body,
    });
    response.writeHead(upstream.status, { 'content-type': 'application/x-amz-json-1.0' });
    response.end(await upstream.text());
  }).listen();
  const client = new DynamoDBClient({ region: 'us-east-1', endpoint: gateway.url, maxAttempts: 2,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
  metadata = new DynamoDBSessionMetadata(table, client);
  await metadata.recordTurn('owner', 'session', { filingUserId: 'filing', title: '', opening: true, running: opening, allocation: true });
  await metadata.turnEnded('owner', 'session', opening, undefined);
  await metadata.recordTurn('owner', 'session', { filingUserId: 'filing', title: 'question', running: queued });
  armed = true;
});

afterEach(async () => { releaseRead(); await gateway.close(); });

it('delivers the queued answer when the opening read acknowledgment overlaps start recording', async () => {
  const reading = metadata.markRead('owner', 'session', { runId: opening.runId });
  await readEntered;
  const frames = [{ type: 'RUN_STARTED', threadId: 'session', runId: 'queued' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'The final answer' }, { type: 'RUN_FINISHED', threadId: 'session', runId: 'queued' }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const response = await relayTurn({ label: 'Test upstream', invoke: async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } }) }, {
    body: '{}', sessionId: 'session', accept: 'text/event-stream', credentials: [],
    saveAgentDocumentEdit: async () => undefined, finished: () => undefined, failed: () => undefined,
    started: () => metadata.turnStarted('owner', 'session', queued),
    ended: (failure) => metadata.turnEnded('owner', 'session', queued, failure),
  });
  const delivered = await response.text();
  await reading;
  expect(delivered).toContain('The final answer');
  expect(delivered).toContain('RUN_FINISHED');
  expect(delivered).not.toContain('TURN_START_FAILED');
  expect(await metadata.get('owner', 'session')).not.toHaveProperty('turn_failure');
});

it('admits a Turn after pure transaction contention without changing its request', async () => {
  transaction = true;
  conflict = 'TransactionCanceledException';
  await expect(metadata.recordTurn('owner', 'session', { filingUserId: 'filing', title: 'next', running: { ...queued, runId: 'next' } })).resolves.toBe('filing');
  expect(await metadata.get('owner', 'session')).toMatchObject({ turn_run_id: 'next', turn_preparing: true });
});

it('preserves the deletion fence if it lands before the SDK retries start recording', async () => {
  onConflict = () => metadata.fence('owner', 'session');
  await expect(metadata.turnStarted('owner', 'session', queued)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  expect(await metadata.get('owner', 'session')).toBeNull();
});

it.each(['TransactionConflictException', 'TransactionCanceledException'] as const)('surfaces exhausted %s contention', async (code) => {
  conflict = code;
  permanent = true;
  transaction = code === 'TransactionCanceledException';
  const operation = transaction
    ? metadata.recordTurn('owner', 'session', { filingUserId: 'filing', title: 'next', running: queued })
    : metadata.turnStarted('owner', 'session', queued);
  await expect(operation).rejects.toThrow();
  expect(failures).toBe(2);
});

it('does not retry an unrelated storage refusal', async () => {
  conflict = 'AccessDeniedException';
  await expect(metadata.turnStarted('owner', 'session', queued)).rejects.toMatchObject({ name: 'AccessDeniedException' });
  expect(failures).toBe(1);
});

it('does not retry a transaction that also refused an authorization condition', async () => {
  conflict = 'TransactionCanceledException';
  transaction = true;
  conditional = true;
  await expect(metadata.recordTurn('owner', 'session', { filingUserId: 'filing', title: 'next', running: queued })).rejects.toThrow();
  expect(failures).toBe(1);
});
