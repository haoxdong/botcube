import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { defined } from '../test/defined.js';
import { startInProcess } from '../test/in-process.js';
import { SessionBusyError } from './session-metadata.js';

it('waits for Main writers without fencing superseding user Turns, then fences only the external post', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const first = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    await expect(stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post')).rejects.toThrow(SessionBusyError);
    const newer = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    expect(newer.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await first();
    await first();
    await expect(stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post')).rejects.toThrow(SessionBusyError);
    await newer();
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    await expect(stack.sessionMetadata.beginDispatch('account-1', 'main')).rejects.toThrow(SessionBusyError);
    await defined(post.markSucceeded, 'post completion')('session-post');
    await defined(post.markSucceeded, 'post completion')('session-post');
    const after = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    expect(after.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await after();
    await post();
  } finally { await stack.stop(); }
});

it('keeps an unknown external post fenced across Account Claim and releases only confirmed completion', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    await stack.sessionMetadata.transferOwner('account-1', 'destination');
    await expect(stack.sessionMetadata.beginDispatch('destination', 'main')).rejects.toThrow(SessionBusyError);
    await expect(post()).rejects.toThrow('completion is unproved');
    await defined(post.markSucceeded, 'confirmed Lambda completion')('session-post');
    const continued = await stack.sessionMetadata.beginDispatch('destination', 'main');
    expect(continued.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await continued();
    await post();
  } finally { await stack.stop(); }
});

it('issues a trusted epoch only when the reuse gate is on, and advances it after external mutation', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const disabled = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    expect(disabled.snapshotEpoch).toBeUndefined();
    await disabled();
    const first = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'runtime', true);
    expect(first.snapshotEpoch).toMatch(/^[0-9a-f-]{36}$/);
    await first();
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    await defined(post.markSucceeded, 'post completion')('session-post');
    await post();
    const next = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'runtime', true);
    expect(next.snapshotEpoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(next.snapshotEpoch).not.toBe(first.snapshotEpoch);
    await next();
    const disabledAgain = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    expect(disabledAgain.snapshotEpoch).toBeUndefined();
    await disabledAgain();
  } finally { await stack.stop(); }
});

it('reloads the epoch when a previously read Runtime admission resumes after an external post', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const initial = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'runtime', true);
    await initial();
    let signalRead!: () => void;
    let resumeRead!: () => void;
    const read = new Promise<void>((resolve) => { signalRead = resolve; });
    const resume = new Promise<void>((resolve) => { resumeRead = resolve; });
    let held = false;
    stack.table.client.middlewareStack.add((next, context) => async (args) => {
      const result = await next(args);
      if (!held && context.commandName === 'GetItemCommand' && JSON.stringify(args.input).includes('SESSION#main')) {
        held = true;
        signalRead();
        await resume;
      }
      return result;
    }, { step: 'initialize', name: 'holdPreviousSessionIdentity' });
    const delayed = stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'runtime', true);
    await read;
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    await defined(post.markSucceeded, 'confirmed post')('session-post');
    await post();
    resumeRead();
    const admitted = await delayed;
    const next = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'runtime', true);
    expect(admitted.snapshotEpoch).toEqual(next.snapshotEpoch);
    expect(admitted.snapshotEpoch).not.toEqual(initial.snapshotEpoch);
    await admitted();
    await next();
  } finally { await stack.stop(); }
});

it('keeps registered Runtime ownership under the filing identity after Account Claim', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const writer = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    await stack.sessionMetadata.transferOwner('account-1', 'destination');
    await expect(stack.sessionMetadata.beginDispatch('destination', 'main', undefined, undefined, 'session-post')).rejects.toThrow(SessionBusyError);
    await Promise.all([writer(), writer()]);
    const post = await stack.sessionMetadata.beginDispatch('destination', 'main', undefined, undefined, 'session-post');
    expect(post.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await defined(post.markSucceeded, 'confirmed post')('session-post');
    await post();
  } finally { await stack.stop(); }
});

it('retains a rejected Runtime writer until its exact stop is confirmed and releases recovery once', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const writer = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    await defined(writer.markRejected, 'rejected Runtime proof')('runtime-target');
    await expect(writer()).rejects.toThrow('completion is unproved');
    const session = defined(writer.session, 'registered Session');
    const recovered = defined((await stack.sessionMetadata.rejectedDispatches(session, 'runtime-target'))[0], 'recoverable exact writer');
    await expect(recovered()).rejects.toThrow('completion is unproved');
    await expect(stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post')).rejects.toThrow(SessionBusyError);
    await defined(recovered.confirmStopped, 'confirmed exact Runtime stop')();
    await Promise.all([recovered(), recovered()]);
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    expect(post.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await defined(post.markSucceeded, 'confirmed post')('session-post');
    await post();
  } finally { await stack.stop(); }
});

it('keeps the external fence when coupled completion fails and never treats a different completion as committed', async () => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    const mark = defined(post.markSucceeded, 'confirmed post marker');
    const ledgerKey = { pk: 'TEST_COMPLETION', sk: 'POST' };
    const completion = { Update: {
      TableName: stack.table.name, Key: ledgerKey, UpdateExpression: 'SET phase = :posted',
      ConditionExpression: 'phase = :posting', ExpressionAttributeValues: { ':posted': 'posted', ':posting': 'posting' },
    } };
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: { ...ledgerKey, phase: 'running' } }));
    await expect(mark('session-post', completion)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    await expect(stack.sessionMetadata.beginDispatch('account-1', 'main')).rejects.toThrow(SessionBusyError);
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: { ...ledgerKey, phase: 'posting' } }));
    await mark('session-post', completion);
    await mark('session-post', completion);
    const different = { Update: { ...completion.Update, Key: { pk: 'TEST_COMPLETION', sk: 'OTHER' } } };
    await expect(mark('session-post', different)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    const resumed = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    expect(resumed.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await resumed();
    await post();
  } finally { await stack.stop(); }
});

it('releases an external registration only when its caller proves Lambda was never submitted', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const post = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    const abort = defined(post.abortUnsubmitted, 'unsubmitted post cancellation');
    await Promise.all([abort(), abort()]);
    const writer = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    expect(writer.session).toMatchObject({ filing_user_id: 'original', session_id: 'main' });
    await writer();
    const completed = await stack.sessionMetadata.beginDispatch('account-1', 'main', undefined, undefined, 'session-post');
    await defined(completed.markSucceeded, 'post completed')('session-post');
    await expect(defined(completed.abortUnsubmitted, 'cannot abort completed post')()).rejects.toThrow('completion is unproved');
    await completed();
  } finally { await stack.stop(); }
});

it('removes idle writer control only after durable Session purge completion', async () => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'main', { filingUserId: 'original', title: 'Main' });
    const writer = await stack.sessionMetadata.beginDispatch('account-1', 'main');
    await writer();
    const session = defined(await stack.sessionMetadata.fence('account-1', 'main'), 'durable deletion fence');
    await stack.sessionMetadata.completePurge(session);
    await stack.sessionMetadata.completePurge(session);
    await expect(stack.sessionMetadata.beginDispatch('account-1', 'main')).rejects.toThrow('main');
    expect(await stack.sessionMetadata.pendingPurges()).toEqual([]);
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: { pk: 'WRITERS#["original","main"]', sk: 'CONTROL', external_token: 'unknown-writer' } }));
    await expect(stack.sessionMetadata.completePurge(session)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
  } finally { await stack.stop(); }
});
