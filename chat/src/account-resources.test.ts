import { QueryCommand } from '@aws-sdk/lib-dynamodb';
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
