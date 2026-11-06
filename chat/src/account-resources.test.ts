import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { AccountResources } from './account-resources.js';
import { memoryDocuments } from '../test/memory-documents.js';
it('deletes Agent Computer screenshots across every DynamoDB page while leaving another account alone', async () => {
  const documents = memoryDocuments();
  const first = { pk: 'AGENT_COMPUTER#acct_0123456789', sk: 'SCREENSHOT#chat-1', screenshot: 'first screenshot' };
  const second = { pk: first.pk, sk: 'SCREENSHOT#chat-2', screenshot: 'second screenshot' };
  const pages = [
    { $metadata: {}, Items: [first], LastEvaluatedKey: { pk: first.pk, sk: first.sk } },
    { $metadata: {}, Items: [second] },
  ];
  const store = new AccountResources('accounts', {
    send: async (command) => {
      if (!(command instanceof QueryCommand)) return documents.send(command);
      const page = pages.shift();
      if (page === undefined) throw new Error('DynamoDB has no further screenshot page');
      return page;
    },
  });
  await store.saveAgentComputer('acct_0123456789', { profileId: 'profile-1' });
  await store.saveAgentComputerScreenshot('acct_0123456789', 'chat-1', first.screenshot);
  await store.saveAgentComputerScreenshot('acct_0123456789', 'chat-2', second.screenshot);
  await store.saveAgentComputerScreenshot('acct_9876543210', 'chat-1', 'other screenshot');

  await store.deleteAgentComputer('acct_0123456789');

  expect(await store.agentComputer('acct_0123456789')).toEqual({ profileId: null });
  expect(await store.agentComputerScreenshot('acct_0123456789', 'chat-1')).toBeNull();
  expect(await store.agentComputerScreenshot('acct_0123456789', 'chat-2')).toBeNull();
  expect(await store.agentComputerScreenshot('acct_9876543210', 'chat-1')).toBe('other screenshot');
});

it('shares running Session records across tasks and requires a lease for every write', async () => {
  const documents = memoryDocuments();
  const first = new AccountResources('chat', documents);
  const replacement = new AccountResources('chat', documents);
  const record = { accountId: 'acct_test', threadId: 'chat-1', sessionId: 'browser-1', phase: 'awake' as const, idleDeadline: 123456 };
  await expect(first.saveRunningAgentComputer(record)).rejects.toThrow('require its account lease');
  await first.withAgentComputerLease('acct_test', () => first.saveRunningAgentComputer(record), 'chat-1');
  expect(await replacement.runningAgentComputer('acct_test', 'chat-1')).toEqual(record);
  expect(await replacement.runningAgentComputers('acct_other')).toEqual([]);
  expect(await replacement.runningAgentComputers()).toEqual([record]);
  await replacement.withAgentComputerLease('acct_test', () => replacement.deleteRunningAgentComputer('acct_test', 'chat-1'), 'chat-1');
  expect(await first.runningAgentComputer('acct_test', 'chat-1')).toBeNull();
});

it('fences stream claims and lets the holder renew and release them across tasks', async () => {
  const documents = memoryDocuments();
  const first = new AccountResources('chat', documents);
  const replacement = new AccountResources('chat', documents);
  const record = { accountId: 'acct_test', threadId: 'chat-1', sessionId: 'browser-1', holder: 'first', expiresAt: Date.now() + 5000 };
  expect(await first.claimAgentComputerStream(record)).toBe(true);
  expect(await replacement.claimAgentComputerStream({ ...record, holder: 'second' })).toBe(false);
  expect(await replacement.releaseAgentComputerStream('browser-1', 'second')).toBe(false);
  expect(await first.renewAgentComputerStream('browser-1', 'first', record.expiresAt + 5000)).toBe(true);
  expect(await replacement.agentComputerStream('browser-1')).toEqual({ ...record, expiresAt: record.expiresAt + 5000 });
  expect(await replacement.releaseAgentComputerStream('browser-1', 'first')).toBe(true);
  expect(await first.agentComputerStream('browser-1')).toBeNull();
});


it('discovers due Files retirements across pages, retains Claim ownership, and postpones a completed sweep', async () => {
  const documents = memoryDocuments();
  const requests: object[] = [];
  const pages = [
    { $metadata: {}, Items: [{ sk: 'acct_source', notBefore: 0 }], LastEvaluatedKey: { pk: 'FILES_CLEANUP', sk: 'acct_source' } },
    { $metadata: {}, Items: [{ sk: 'acct_future', notBefore: Number.MAX_SAFE_INTEGER }, { sk: 'acct_deleted', notBefore: 0 }] },
  ];
  const store = new AccountResources('accounts', {
    send: async (command) => {
      if (!(command instanceof QueryCommand)) return documents.send(command);
      requests.push(command.input);
      const page = pages.shift();
      if (page === undefined) throw new Error('Unexpected cleanup page');
      return page;
    },
  });
  await store.retireFiles('acct_source', 'acct_destination', 0);
  expect(await store.pendingFilesCleanup()).toEqual(['acct_source', 'acct_deleted']);
  expect(requests[1]).toMatchObject({ ExclusiveStartKey: { pk: 'FILES_CLEANUP', sk: 'acct_source' }, ConsistentRead: true });
  await store.scheduleFilesCleanup('acct_source', Number.MAX_SAFE_INTEGER, 0);
  const restarted = new AccountResources('accounts', documents);
  expect(await restarted.filesRetirement('acct_source')).toEqual({ destinationAccountId: 'acct_destination', lastCredentialExpiresAt: 0 });
  expect(await restarted.filesRetirement('acct_active')).toBeNull();
  expect(await restarted.pendingFilesCleanup()).toEqual([]);
});


it('does not delete a newer retirement or recreate completed cleanup work', async () => {
  const store = new AccountResources('accounts', memoryDocuments());
  await store.retireFiles('acct_source', null, 100);
  await store.retireFiles('acct_source', null, 200);
  expect(await store.filesRetirement('acct_source')).toEqual({ destinationAccountId: null, lastCredentialExpiresAt: 100 });
  await store.call('PutItem', new PutCommand({ TableName: 'accounts', Item: { pk: 'FILES_CLEANUP', sk: 'acct_source', destinationAccountId: null, lastCredentialExpiresAt: 200, notBefore: 200 } }));
  await expect(store.completeFilesCleanup('acct_source', 100)).rejects.toThrow('DeleteItem failed');
  await expect(store.scheduleFilesCleanup('acct_source', 300, 100)).rejects.toThrow('UpdateItem failed');
  expect(await store.filesRetirement('acct_source')).toEqual({ destinationAccountId: null, lastCredentialExpiresAt: 200 });
  await store.completeFilesCleanup('acct_source', 200);
  expect(await store.filesRetirement('acct_source')).toBeNull();
  await expect(store.scheduleFilesCleanup('acct_source', 400, 200)).rejects.toThrow('UpdateItem failed');
  expect(await store.filesRetirement('acct_source')).toBeNull();
});

it('distinguishes an active Claim destination from a deleted or deleting account', async () => {
  const store = new AccountResources('accounts', memoryDocuments());
  await store.call('PutItem', new PutCommand({ TableName: 'accounts', Item: { pk: 'ACCOUNT#acct_active', sk: 'META', record: {} } }));
  await store.call('PutItem', new PutCommand({ TableName: 'accounts', Item: { pk: 'ACCOUNT#acct_deleting', sk: 'META', record: { deletionOperationId: 'deleting' } } }));
  expect(await store.filesAccountActive('acct_active')).toBe(true);
  expect(await store.filesAccountActive('acct_deleting')).toBe(false);
  expect(await store.filesAccountActive('acct_deleted')).toBe(false);
});
