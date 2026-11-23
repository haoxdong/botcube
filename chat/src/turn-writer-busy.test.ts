import { DynamoDBDocumentClient, UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { SessionBusyError } from './session-metadata.js';
import { sessionAccessError } from './sessions.js';
import { filed } from '../test/stock-bot.js';

const nextTurn = (stack: InProcessStack, sessionId: string, signal?: AbortSignal) => stack.app.request('/', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  ...(signal === undefined ? {} : { signal }),
  body: JSON.stringify({ threadId: sessionId, runId: 'second', state: {}, tools: [], context: [], forwardedProps: {},
    messages: [{ id: 'question', role: 'user', content: 'Next question' }] }),
});

async function previousWriter(stack: InProcessStack, kind: 'runtime' | 'session-post') {
  await stack.allocate('acct_account-1', 'writer-busy');
  await stack.sessionMetadata.recordTurn('acct_account-1', 'writer-busy', { filingUserId: filed('acct_account-1'), title: 'First reply' });
  return stack.sessionMetadata.beginDispatch('acct_account-1', 'writer-busy', undefined, undefined, kind);
}

function observeWait() {
  let observed!: () => void;
  const waiting = new Promise<void>((resolve) => { observed = resolve; });
  const logged = vi.spyOn(console, 'warn').mockImplementation(() => observed());
  return { waiting, logged };
}

it('answers the next Turn while the previous Runtime writer remains registered', async () => {
  const stack = await startInProcess();
  try {
    const writer = await previousWriter(stack, 'runtime');
    const response = await nextTurn(stack, 'writer-busy');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('RUN_FINISHED');
    await writer();
  } finally { await stack.stop(); }
});

it.each([
  ['Turn', false], ['delete', false], ['Turn', true], ['delete', true],
] as const)('accepts a %s after an abandoned scheduled-post lease expires (legacy lease: %s)', async (operation, legacy) => {
  const stack = await startInProcess();
  const client = new AbortController();
  const waiting = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    if (String(message).startsWith('Turn is waiting for Session persistence writer')) client.abort();
  });
  try {
    const previous = await previousWriter(stack, 'session-post');
    if (legacy) await DynamoDBDocumentClient.from(stack.table.client).send(new UpdateCommand({
      TableName: stack.table.name,
      Key: { pk: `WRITERS#${JSON.stringify([previous.session.filing_user_id, previous.session.session_id])}`, sk: 'CONTROL' },
      UpdateExpression: 'REMOVE lease_token, lease_expires_at',
    }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 3_600_000 + 1);
    if (operation === 'Turn') {
      let admissionWrites = 0;
      stack.table.client.middlewareStack.add((next, context) => async (args) => {
        const { TransactItems } = args.input as TransactWriteCommandInput;
        if (context.commandName?.startsWith('TransactWrite') && TransactItems?.some(({ Update }) =>
          Update?.Key?.sk === 'CONTROL' && Update.ReturnValuesOnConditionCheckFailure === 'ALL_OLD'
        )) admissionWrites += 1;
        return next(args);
      }, { step: 'initialize', name: 'countTurnAdmissionWrites' });
      const response = await nextTurn(stack, 'writer-busy', client.signal);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain('RUN_FINISHED');
      if (!legacy) expect(admissionWrites).toBe(1);
      await expect(defined(previous.markSucceeded, 'previous post completion')('session-post')).rejects.toThrow();
    } else {
      const response = await stack.app.request('/threads/writer-busy', { method: 'DELETE' });
      expect(response.status).toBe(204);
      await expect.poll(() => stack.sessionApi.events()).toContainEqual({
        operation: 'purge', userId: filed('acct_account-1'), sessionId: 'writer-busy',
      });
      await expect.poll(() => stack.sessionMetadata.pendingPurges()).toEqual([]);
    }
  } finally {
    vi.useRealTimers();
    waiting.mockRestore();
    await stack.stop();
  }
});

it('waits for the exclusive writer, answers the second Turn and reopens without a saved failure', async () => {
  const stack = await startInProcess();
  const { waiting, logged } = observeWait();
  try {
    const writer = await previousWriter(stack, 'session-post');
    const response = nextTurn(stack, 'writer-busy');
    await Promise.race([waiting, response]);
    await defined(writer.markSucceeded, 'post completion')('session-post');
    await writer();
    const answer = await response;
    expect.soft(answer.status).toBe(200);
    expect.soft(await answer.text()).toContain('RUN_FINISHED');
    const replay = await stack.app.request('/threads/writer-busy');
    expect.soft(await replay.json()).not.toHaveProperty('failure');
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('session_id=writer-busy run_id=second'),
      expect.objectContaining({ message: 'Session persistence writer is still active' }),
    );
  } finally {
    logged.mockRestore();
    await stack.stop();
  }
});

it.each(['cancelled', 'deadline', 'deleted'] as const)('ends a %s wait without dispatching or saving an unmapped busy message', async (outcome) => {
  const stack = await startInProcess();
  const { waiting, logged } = observeWait();
  const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const client = new AbortController();
  try {
    const writer = await previousWriter(stack, 'session-post');
    if (outcome === 'deadline') vi.useFakeTimers({ toFake: ['Date'] });
    const response = nextTurn(stack, 'writer-busy', client.signal);
    await Promise.race([waiting, response]);
    if (outcome === 'cancelled') client.abort();
    if (outcome === 'deadline') vi.setSystemTime(Date.now() + 61_000);
    if (outcome === 'deleted') {
      await stack.sessionMetadata.fence('acct_account-1', 'writer-busy');
      await defined(writer.markSucceeded, 'post completion')('session-post');
      await writer();
    }
    const refusal = await response;
    expect.soft(refusal.status).toBe(outcome === 'deleted' ? 410 : 409);
    if (outcome !== 'deleted') {
      expect.soft(await refusal.json()).toEqual({ detail: 'Test Bot is still posting a scheduled task. Send your message again in a minute.', code: 'SESSION_BUSY' });
      const replay = await stack.app.request('/threads/writer-busy');
      expect.soft(await replay.json()).toHaveProperty('failure.message', 'Test Bot is still posting a scheduled task. Send your message again in a minute.');
      expect.soft(failed).toHaveBeenCalledWith('POST / failed', expect.objectContaining({
        cause: expect.objectContaining({ message: 'Session persistence writer is still active' }),
      }));
    }
    if (outcome === 'deadline') {
      expect(failed).toHaveBeenCalledWith('Scheduled task post blocked a Turn past its deadline', {
        session_id: 'writer-busy', run_id: 'second', holder_token: writer.token, created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    }
    expect(stack.agentcore.invocations()).toHaveLength(0);
    if (outcome !== 'deleted') {
      await defined(writer.markSucceeded, 'post completion')('session-post');
      await writer();
    }
  } finally {
    vi.useRealTimers();
    logged.mockRestore();
    failed.mockRestore();
    await stack.stop();
  }
});

it.each([
  ['Pebble', 'Pebble is still busy. Send your message again in a minute.'],
  ['', 'Still busy. Send your message again in a minute.'],
])('maps an unknown holder for agent %j without claiming a scheduled task', (name, detail) => {
  expect(sessionAccessError(new SessionBusyError('busy'), name)).toMatchObject({ status: 409, detail, code: 'SESSION_BUSY' });
});

it.each([
  ['Pebble', 'Pebble is still posting a scheduled task. Send your message again in a minute.'],
  ['', 'Still posting a scheduled task. Send your message again in a minute.'],
])('uses the configured agent name %j in a scheduled-post refusal', async (name, detail) => {
  const stack = await startInProcess({ overrides: { agentDocuments: {
    agentIdentity: { name, character: 'A template agent', vibe: 'Plain', avatar: '' }, soul: 'Be brief.',
  } } });
  const { waiting, logged } = observeWait();
  const client = new AbortController();
  try {
    const writer = await previousWriter(stack, 'session-post');
    const response = nextTurn(stack, 'writer-busy', client.signal);
    await Promise.race([waiting, response]);
    client.abort();
    const answer = await response;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ detail, code: 'SESSION_BUSY' });
    await defined(writer.markSucceeded, 'post completion')('session-post');
    await writer();
  } finally { logged.mockRestore(); await stack.stop(); }
});

it('uses the edited Agent Identity name already loaded for the Turn', async () => {
  const stack = await startInProcess();
  const { waiting, logged } = observeWait();
  const client = new AbortController();
  try {
    const edited = await stack.app.request('/agent/identity', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Quill', character: 'An analyst', vibe: 'Plain', avatar: '' }),
    });
    expect(edited.status).toBe(204);
    expect(await (await stack.app.request('/agent')).json()).toHaveProperty('name', 'Quill');
    const writer = await previousWriter(stack, 'session-post');
    const response = nextTurn(stack, 'writer-busy', client.signal);
    await Promise.race([waiting, response]);
    client.abort();
    const answer = await response;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ detail: 'Quill is still posting a scheduled task. Send your message again in a minute.', code: 'SESSION_BUSY' });
    await defined(writer.markSucceeded, 'post completion')('session-post');
    await writer();
  } finally { logged.mockRestore(); await stack.stop(); }
});
