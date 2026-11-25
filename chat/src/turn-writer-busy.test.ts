import { type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
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

it.each(['Turn', 'delete'] as const)('accepts a %s after an abandoned scheduled-post lease expires', async (operation) => {
  const stack = await startInProcess();
  const client = new AbortController();
  const waiting = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    if (message === 'Waiting for the Session writer') client.abort();
  });
  try {
    const previous = await previousWriter(stack, 'session-post');
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
      expect(admissionWrites).toBe(1);
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
    vi.useFakeTimers({ toFake: ['Date'] });
    const response = nextTurn(stack, 'writer-busy');
    await Promise.race([waiting, response]);
    expect(stack.agentcore.invocations()).toHaveLength(0);
    vi.setSystemTime(Date.now() + 59_000);
    await defined(writer.markSucceeded, 'post completion')('session-post');
    await writer();
    const answer = await response;
    expect.soft(answer.status).toBe(200);
    expect.soft(await answer.text()).toContain('RUN_FINISHED');
    const replay = await stack.app.request('/threads/writer-busy');
    expect.soft(await replay.json()).not.toHaveProperty('failure');
  } finally {
    vi.useRealTimers();
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
    if (outcome === 'deadline') {
      const context = { session_id: 'writer-busy', run_id: 'second' };
      expect.soft(logged).toHaveBeenCalledWith('Waiting for the Session writer', context, expect.any(Error));
      expect.soft(failed).toHaveBeenCalledWith('Session writer wait exceeded its budget', {
        ...context, holder_token: writer.token, created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    }
    expect.soft(refusal.status).toBe(outcome === 'deleted' ? 410 : 409);
    if (outcome !== 'deleted') {
      expect.soft(await refusal.json()).toEqual({ detail: 'This chat is busy. Try again.', code: 'SESSION_BUSY' });
      const replay = await stack.app.request('/threads/writer-busy');
      expect.soft(await replay.json()).toHaveProperty('failure.message', 'This chat is busy. Try again.');
      expect.soft(failed).toHaveBeenCalledWith('POST / failed', expect.objectContaining({
        cause: expect.objectContaining({ message: 'Session persistence writer is still active' }),
      }));
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
