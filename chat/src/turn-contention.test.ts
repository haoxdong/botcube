import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';

const detail = 'Another Session operation conflicted with this Turn. Retry the Turn.';

it.each([
  ['admission', ['TransactionConflict', 'None', 'None'], 409],
  ['dispatch', ['TransactionConflict', 'TransactionConflict', 'None', 'None', 'None'], 409],
  ['dispatch', ['None', 'TransactionConflict', 'None', 'None', 'None'], 409],
  ['admission', ['None', 'None', 'None'], 500],
  ['dispatch', ['None', 'TransactionConflict', 'ValidationError', 'None', 'None'], 500],
  ['dispatch', ['ConditionalCheckFailed', 'TransactionConflict', 'None', 'None', 'None'], 410],
] as const)('classifies %s contention without retrying or blocking sibling Sessions (%j)', async (phase, codes, status) => {
  const stack = await startInProcess();
  await Promise.all(['rejected', 'left', 'right'].map((id) => stack.allocate('account-1', id)));
  const allocated = await stack.sessionMetadata.get('account-1', 'rejected');
  let rejected = 0;
  stack.table.client.middlewareStack.add((next, context) => async (args) => {
    const input = args.input as TransactWriteCommandInput;
    const items = input.TransactItems;
    const target = items?.some(({ Update }) => Update?.Key?.sk === 'SESSION#rejected');
    const dispatch = items?.some(({ Put }) => typeof Put?.Item?.pk === 'string' && Put.Item.pk.startsWith('DISPATCH#'));
    if (context.commandName?.startsWith('TransactWrite') && target && dispatch === (phase === 'dispatch')) {
      rejected += 1;
      throw new TransactionCanceledException({ $metadata: {}, message: 'Transaction cancelled, please refer cancellation reasons for specific reasons', CancellationReasons: codes.map((Code) => ({ Code })) });
    }
    return next(args);
  }, { step: 'initialize', name: 'injectTurnContention' });
  const post = (threadId: string) => stack.app.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, runId: `run-${threadId}`, state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
  });
  try {
    const responses = await Promise.all(['rejected', 'left', 'right'].map(post));
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map(({ status }) => status)).toEqual([status, 200, 200]);
    if (status === 409) expect(JSON.parse(bodies[0] ?? '')).toEqual({ detail, code: 'SESSION_CONCURRENCY_CONFLICT' });
    else if (status === 410) expect(JSON.parse(bodies[0] ?? '')).toEqual({ detail: 'The Session was deleted' });
    else expect(bodies[0]).toBe('Internal Server Error');
    expect(bodies[1]).toContain('RUN_FINISHED');
    expect(bodies[2]).toContain('RUN_FINISHED');
    expect(rejected).toBe(1);
    expect(stack.agentcore.invocations().map(({ body }) => (JSON.parse(body) as { threadId: string }).threadId).sort()).toEqual(['left', 'right']);
    if (phase === 'dispatch') {
      stack.sessionApi.reply('rejected', 200, { messages: [] });
      expect(await (await stack.app.request('/threads/rejected')).json()).toMatchObject({ running: false });
    } else expect(await stack.sessionMetadata.get('account-1', 'rejected')).toEqual(allocated);
  } finally {
    await stack.stop();
  }
});
