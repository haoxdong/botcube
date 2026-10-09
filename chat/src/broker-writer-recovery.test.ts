import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { defined } from '../test/defined.js';
import { startInProcess } from '../test/in-process.js';

it.each(['tracked', 'continuation'] as const)('acknowledges only exact proved writers without promoting %s Session erasure', async (generation) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  try {
    if (generation === 'continuation') await documents.send(new PutCommand({ TableName: stack.table.name, Item: { pk: 'SESSIONS#account-1', sk: 'SESSION#proof-session', session_id: 'proof-session', filing_user_id: 'filed-original', title: 'Original history' } }));
    else await stack.sessionMetadata.recordTurn('account-1', 'proof-session', { filingUserId: 'filed-original', title: 'Original history' });
    const writer = await stack.sessionMetadata.beginDispatch('account-1', 'proof-session');
    const session = defined(writer.session, 'registered writer identity');
    const token = defined(writer.token, 'registered writer token');
    const mark = defined(writer.markSucceeded, 'durable successful writer marker');
    const Key = { pk: `DISPATCH#${JSON.stringify(['filed-original', 'proof-session'])}`, sk: token };
    await expect(stack.sessionMetadata.acknowledgeSuccessfulDispatch(session, token, 'memory-event')).rejects.toThrow('settlement is unproved');
    await mark('memory-event');
    await expect(stack.sessionMetadata.acknowledgeSuccessfulDispatch(session, token, 'session-post')).rejects.toThrow('settlement is unproved');
    const row = defined((await documents.send(new GetCommand({ TableName: stack.table.name, Key, ConsistentRead: true }))).Item, 'successful writer proof');
    expect(row).toMatchObject({ session_id: 'proof-session', filing_user_id: 'filed-original', runtime_binding: session.runtime_binding, runtime_generation: session.runtime_generation, writer_succeeded: 'memory-event' });
    await Promise.all([stack.sessionMetadata.acknowledgeSuccessfulDispatch(session, token, 'memory-event'), stack.sessionMetadata.acknowledgeSuccessfulDispatch(session, token, 'memory-event')]);
    expect((await documents.send(new GetCommand({ TableName: stack.table.name, Key, ConsistentRead: true }))).Item).toBeUndefined();
    await expect(mark('memory-event')).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect((await documents.send(new GetCommand({ TableName: stack.table.name, Key, ConsistentRead: true }))).Item).toBeUndefined();
    if (generation === 'continuation') {
      await expect(stack.sessionMetadata.assertNoDispatch(session)).rejects.toThrow('legacy settlement is unproved');
      expect(await stack.sessionMetadata.get('account-1', 'proof-session')).toMatchObject({ runtime_generation: 'continuation-v1', legacy_settlement_unproved: true, filing_user_id: 'filed-original', title: 'Original history' });
    } else await expect(stack.sessionMetadata.assertNoDispatch(session)).resolves.toBeUndefined();
  } finally { await stack.stop(); }
});

it.each(['filing_user_id', 'session_id', 'runtime_binding', 'runtime_generation', 'writer_succeeded'] as const)('keeps a mismatched %s writer proof pending', async (field) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'proof-session', { filingUserId: 'filed-original', title: 'Original' });
    const writer = await stack.sessionMetadata.beginDispatch('account-1', 'proof-session');
    const session = defined(writer.session, 'registered Session');
    const token = defined(writer.token, 'registered token');
    await defined(writer.markSucceeded, 'writer marker')('memory-event');
    const Key = { pk: `DISPATCH#${JSON.stringify(['filed-original', 'proof-session'])}`, sk: token };
    const row = defined((await documents.send(new GetCommand({ TableName: stack.table.name, Key, ConsistentRead: true }))).Item, 'successful proof');
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: { ...row, [field]: 'different' } }));
    await expect(stack.sessionMetadata.acknowledgeSuccessfulDispatch(session, token, 'memory-event')).rejects.toThrow('settlement is unproved');
    await expect(stack.sessionMetadata.assertNoDispatch(session)).rejects.toThrow('still registered');
    expect((await documents.send(new GetCommand({ TableName: stack.table.name, Key, ConsistentRead: true }))).Item).toBeDefined();
  } finally { await stack.stop(); }
});

it.each(['ledger', 'registration'] as const)('rolls back both successful post facts when the %s condition fails', async (failure) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  try {
    const mainChat = await stack.sessionMetadata.mainChat('account-1', 'filed-original');
    await stack.sessionMetadata.recordTurn('account-1', mainChat, { filingUserId: 'filed-original', title: 'Original Main' });
    const store = stack.sessionMetadata.scheduledRuns;
    const delivery = await store.claim('account-1', 'scheduled-task', 'delivery-atomic', 'filed-original', mainChat);
    await store.admit(delivery);
    const writer = await stack.sessionMetadata.beginDispatch('account-1', mainChat);
    const posting = await store.posting(delivery, writer, false);
    const token = defined(writer.token, 'exact post token');
    const writerKey = { pk: `DISPATCH#${JSON.stringify(['filed-original', mainChat])}`, sk: token };
    const ledgerKey = { pk: 'SESSIONS#account-1', sk: 'SCHEDULED_DELIVERY#delivery-atomic' };
    const writerRow = defined((await documents.send(new GetCommand({ TableName: stack.table.name, Key: writerKey, ConsistentRead: true }))).Item, 'registered post writer');
    const ledgerRow = defined((await documents.send(new GetCommand({ TableName: stack.table.name, Key: ledgerKey, ConsistentRead: true }))).Item, 'posting delivery ledger');
    const rejected = failure === 'ledger' ? { ...ledgerRow, phase: 'running' } : { ...writerRow, dispatcher: 'other-task' };
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: rejected }));
    const mark = defined(writer.markSucceeded, 'atomic post success writer');
    await expect(mark('session-post', store.postedTransaction(posting))).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    const retainedWriter = defined((await documents.send(new GetCommand({ TableName: stack.table.name, Key: writerKey, ConsistentRead: true }))).Item, 'retained registration');
    const retainedLedger = defined((await documents.send(new GetCommand({ TableName: stack.table.name, Key: ledgerKey, ConsistentRead: true }))).Item, 'retained delivery');
    expect(retainedWriter.writer_succeeded).toBeUndefined();
    expect(retainedLedger.phase).toBe(failure === 'ledger' ? 'running' : 'posting');
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: failure === 'ledger' ? ledgerRow : writerRow }));
    await mark('session-post', store.postedTransaction(posting));
    expect((await documents.send(new GetCommand({ TableName: stack.table.name, Key: writerKey, ConsistentRead: true }))).Item).toMatchObject({ writer_succeeded: 'session-post' });
    expect((await documents.send(new GetCommand({ TableName: stack.table.name, Key: ledgerKey, ConsistentRead: true }))).Item).toMatchObject({ phase: 'posted', postToken: token, postSession: writer.session });
  } finally { await stack.stop(); }
});
