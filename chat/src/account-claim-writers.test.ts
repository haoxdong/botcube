import { SessionDeletedError } from './session-metadata.js';
import { afterEach, expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
let stack: InProcessStack | undefined;
afterEach(async () => { await stack?.stop(); });

it.each(['new', 'existing'])('refuses a late Turn during Account Claim for a %s Session', async (kind) => {
  stack = await startInProcess();
  const running = stack;
  await running.sessionMetadata.recordTurn('claim-source', 'a-original', { filingUserId: 'filed-claim-source', title: 'original', provider: 'anthropic' });
  await running.sessionMetadata.recordTurn('claim-source', 'b-second', { filingUserId: 'filed-claim-source', title: 'second', provider: 'anthropic' });
  let transactions = 0;
  let accepting = false;
  let turnStatus = 0;
  let turnBody = "";
  const sessionId = kind === 'new' ? 'late-new' : 'a-original';
  running.table.client.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'TransactWriteItemsCommand' && !accepting && ++transactions === (kind === 'new' ? 1 : 2)) {
      accepting = true;
      const response = await running.app.request('/', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'claim-source' },
        body: JSON.stringify({ threadId: sessionId, runId: 'claim-racing-turn', state: {}, messages: [{ id: 'message', role: 'user', content: 'Hello during claim' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
      });
      turnStatus = response.status;
      turnBody = await response.text();
    }
    return next(args);
  }, { step: 'initialize' });
  await running.history.transfer('claim-source', 'claim-destination');
  expect(turnStatus).toBe(409);
  expect(JSON.parse(turnBody)).toEqual({ detail: 'Account Claim is in progress. Finish signing in and retry.' });
  expect(await running.sessionMetadata.get('claim-source', sessionId)).toBeNull();
  if (kind === 'existing') expect(await running.sessionMetadata.get('claim-destination', sessionId)).not.toBeNull();
  else expect(await running.sessionMetadata.get('claim-destination', sessionId)).toBeNull();
});


it('preserves a Turn accepted before the Claim fence and resumes under its original filing ID', async () => {
  stack = await startInProcess();
  const running = stack;
  async function send(owner: string) {
    const response = await running.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner },
      body: JSON.stringify({ threadId: 'before-claim', runId: 'claim-control-turn', state: {}, messages: [{ id: 'message', role: 'user', content: 'Hello before claim' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
    });
    await response.text();
    return response.status;
  }
  await running.sessionMetadata.recordTurn('claim-source', 'preflight-existing', { filingUserId: 'filed-claim-source', title: 'existing', provider: 'anthropic' });
  let accepted = false;
  running.table.client.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'PutItemCommand' && !accepted) {
      accepted = true;
      expect(await send('claim-source')).toBe(200);
    }
    return next(args);
  }, { step: 'initialize' });
  await running.history.transfer('claim-source', 'claim-destination');
  expect(await running.sessionMetadata.get('claim-source', 'before-claim')).toBeNull();
  expect(await running.sessionMetadata.get('claim-destination', 'before-claim')).toEqual(expect.objectContaining({ filing_user_id: 'filed-claim-source', provider: 'anthropic' }));
  expect(await send('claim-source')).toBe(409);
  expect(await send('claim-destination')).toBe(200);
  expect(accepted).toBe(true);
  expect(running.agentcore.invocations().map((request) => JSON.parse(request.body).forwardedProps.sessionUserId)).toEqual(['filed-claim-source', 'filed-claim-source']);
});

it('refuses source Turns after a partial Claim failure and resumes the claiming account after retry', async () => {
  stack = await startInProcess();
  const running = stack;
  await running.sessionMetadata.recordTurn('claim-source', 'a-moved', { filingUserId: 'filed-claim-source', title: 'moved first', provider: 'anthropic' });
  await running.sessionMetadata.recordTurn('claim-source', 'b-retry', { filingUserId: 'filed-claim-source', title: 'moves on retry', provider: 'anthropic' });
  const failure = new Error('second Claim move failed');
  let moves = 0;
  running.table.client.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'TransactWriteItemsCommand' && ++moves === 2) throw failure;
    return next(args);
  }, { step: 'initialize' });
  await expect(running.history.transfer('claim-source', 'claim-destination')).rejects.toBe(failure);
  expect(await running.sessionMetadata.get('claim-destination', 'a-moved')).not.toBeNull();
  expect(await running.sessionMetadata.get('claim-source', 'b-retry')).not.toBeNull();

  async function send(owner: string) {
    return running.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner },
      body: JSON.stringify({ threadId: 'b-retry', runId: 'claim-retry-turn', state: {}, messages: [{ id: 'message', role: 'user', content: 'Resume after claim' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
    });
  }
  const refused = await send('claim-source');
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ detail: 'Account Claim is in progress. Finish signing in and retry.' });
  expect(running.agentcore.invocations()).toHaveLength(0);

  await running.history.transfer('claim-source', 'claim-destination');
  const resumed = await send('claim-destination');
  expect(resumed.status).toBe(200);
  await resumed.text();
  expect(await running.sessionMetadata.get('claim-source', 'b-retry')).toBeNull();
  expect(await running.sessionMetadata.get('claim-destination', 'b-retry')).toEqual(expect.objectContaining({ filing_user_id: 'filed-claim-source', provider: 'anthropic' }));
  expect(running.agentcore.invocationFor('b-retry').payload.forwardedProps.sessionUserId).toBe('filed-claim-source');
});

it.each(['new', 'existing'])('preserves the filing ID when Claim moves a %s Session after its Turn transaction', async (kind) => {
  stack = await startInProcess();
  const running = stack;
  const sessionId = 'post-commit-claim';
  const filingId = kind === 'existing' ? 'original-filing-id' : 'filed-claim-source';
  if (kind === 'existing') {
    await running.sessionMetadata.recordTurn('claim-source', sessionId, { filingUserId: filingId, title: 'original', provider: 'anthropic' });
  }
  let accepted = false;
  let paused = false;
  let readHeld!: () => void;
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => { readHeld = resolve; });
  const released = new Promise<void>((resolve) => { releaseRead = resolve; });
  running.table.client.middlewareStack.add((next, context) => async (args) => {
    const input = args.input as { Key?: { pk?: string; sk?: string }; TransactItems?: Array<{ Update?: { Key?: { sk?: string } } }> };
    if (context.commandName === 'GetItemCommand' && accepted && !paused && input.Key?.pk === 'SESSIONS#claim-source' && input.Key.sk === `SESSION#${sessionId}`) {
      paused = true;
      readHeld();
      await released;
    }
    const result = await next(args);
    if (context.commandName === 'TransactWriteItemsCommand' && input.TransactItems?.some((item) => item.Update?.Key?.sk === `SESSION#${sessionId}`)) accepted = true;
    return result;
  }, { step: 'initialize' });
  const turn = running.app.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'claim-source' },
    body: JSON.stringify({ threadId: sessionId, runId: 'claim-post-commit-turn', state: {}, messages: [{ id: 'message', role: 'user', content: 'Hello before Claim' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
  });
  await held;
  try {
    await running.history.transfer('claim-source', 'claim-destination');
    expect(await running.sessionMetadata.get('claim-destination', sessionId)).toEqual(expect.objectContaining({ filing_user_id: filingId }));
  } finally {
    releaseRead();
  }
  const response = await turn;
  const stream = await response.text();
  expect(response.status).toBe(200);
  expect(stream).toContain('"type":"RUN_FINISHED"');
  expect(stream).not.toContain('"type":"RUN_ERROR"');
  // The summary is saved after the stream closes.
  await vi.waitFor(async () => expect(await running.sessionMetadata.turnSummaries(filingId)).toEqual([
    expect.objectContaining({ session_id: sessionId, message_id: 'message', request: 'Hello before Claim', completed_at: expect.any(String) }),
  ]), { timeout: 2_000 });
  expect(paused).toBe(true);
  expect(await running.sessionMetadata.get('claim-source', sessionId)).toBeNull();
  expect(running.agentcore.invocationFor(sessionId).payload.forwardedProps.sessionUserId).toBe(filingId);
});

it.each(['source deletion', 'destination deletion', 'Session deletion', 'replacement Turn'])('refuses an accepted dispatch after Claim and %s', async (refusal) => {
  stack = await startInProcess();
  const running = { startedAt: '2026-10-07T00:00:00.000Z', runId: 'accepted-turn' };
  await stack.sessionMetadata.recordTurn('claim-source', 'accepted-session', { filingUserId: 'filed-source', title: 'accepted', provider: 'anthropic', running });
  await stack.history.transfer('claim-source', 'claim-destination');
  if (refusal === 'source deletion') await stack.sessionMetadata.fenceOwner('claim-source');
  if (refusal === 'destination deletion') await stack.sessionMetadata.fenceOwner('claim-destination');
  if (refusal === 'Session deletion') await stack.sessionMetadata.fence('claim-destination', 'accepted-session');
  if (refusal === 'replacement Turn') {
    await stack.sessionMetadata.recordTurn('claim-destination', 'accepted-session', { filingUserId: 'filed-destination', title: 'replacement', provider: 'anthropic', running: { startedAt: running.startedAt, runId: 'replacement-turn' } });
  }
  await expect(stack.sessionMetadata.beginDispatch('claim-source', 'accepted-session', undefined, running)).rejects.toThrow(SessionDeletedError);
});
