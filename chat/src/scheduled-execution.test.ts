import { beforeEach, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ScheduledExecution } from './scheduled-execution.js';
import { AccountResources } from './account-resources.js';
import { BrowserSessionEnded } from './browser-sessions.js';
import { agentComputers } from './agent-computer.js';
import { motoEndpoint } from '../test/fakes/moto.js';
import { createChatTable, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from '../test/fakes/stack.js';

let table: string;
let documents: DynamoDBDocumentClient;
beforeEach(async () => {
  table = `scheduled-cap-${Math.random().toString(36).slice(2)}`;
  await createChatTable(motoEndpoint(), table);
  documents = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', endpoint: motoEndpoint(),
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
});

it('holds one slot across processes and admits its Browser only while running', async () => {
  const first = new ScheduledExecution(table, documents);
  const second = new ScheduledExecution(table, documents);
  const records = new AccountResources(table, documents);
  await documents.send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#owner', sk: 'SESSION#side', scheduled_task_id: 'task' } }));
  await expect(records.scheduledBrowserAdmission('owner', 'side')).rejects.toThrow('active fleet admission');
  await first.acquire('owner', 'side');
  await expect(second.acquire('other', 'other-side')).rejects.toThrow('occupied');
  expect(await records.scheduledBrowserAdmission('owner', 'side')).toEqual({ holder: expect.any(String) });
  await expect(first.release()).rejects.toThrow();
  await first.stopping();
  await expect(records.scheduledBrowserAdmission('owner', 'side')).rejects.toThrow('active fleet admission');
  await expect(second.acquire('other', 'other-side')).rejects.toThrow('occupied');
  await first.release();
  await documents.send(new DeleteCommand({ TableName: table, Key: { pk: 'SESSIONS#owner', sk: 'SESSION#side' } }));
  await second.acquire('other', 'other-side');
  await expect(records.scheduledBrowserAdmission('ordinary', 'ordinary')).resolves.toBeNull();
  await expect(records.scheduledBrowserAdmission('owner', 'side')).rejects.toThrow('active fleet admission');
});

it('retains an uncertain Browser start and refuses to confirm teardown', async () => {
  const execution = new ScheduledExecution(table, documents);
  const records = new AccountResources(table, documents);
  await documents.send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#owner', sk: 'SESSION#side', scheduled_task_id: 'task' } }));
  await execution.acquire('owner', 'side');
  let starts = 0;
  const unused = async () => { throw new Error('not used by this scenario'); };
  const computers = agentComputers({ records: () => records, idleSeconds: 60,
    seed: async () => {},
    browser: () => ({ browserId: 'browser', start: async () => { starts++; throw new Error('lost Browser receipt'); },
      control: unused, automationStream: unused, screenshot: unused, beforeProfileSave: unused,
      createProfile: unused, saveProfile: unused, deleteProfile: unused, stop: unused, handBack: unused }),
    files: () => ({ mount: async () => ({ accessPointArn: 'access', fileSystemArn: 'files', mountPath: '/mnt/files' }),
      list: unused, uploadUrl: unused, downloadUrl: unused, remove: unused, rename: unused, saveArtifact: unused,
      recoverCleanup: unused, mountBinding: unused, transfer: unused, delete: unused }) });
  await expect(computers.wake('owner', 'side')).rejects.toThrow('lost Browser receipt');
  expect(starts).toBe(1);
  await execution.stopping();
  await expect(computers.stopThread('owner', 'side')).rejects.toThrow('receipt is unproved');
  await expect(new ScheduledExecution(table, documents).acquire('other', 'other-side')).rejects.toThrow('occupied');
});


it('keeps capacity after a stop ACK until a reused Browser actually terminates', async () => {
  const execution = new ScheduledExecution(table, documents);
  const records = new AccountResources(table, documents);
  await execution.acquire('owner', 'side');
  await documents.send(new PutCommand({ TableName: table, Item: { pk: 'AGENT_COMPUTER_RUNNING', sk: 'owner#side',
    record: { accountId: 'owner', threadId: 'side', sessionId: 'legacy-browser', phase: 'awake', idleDeadline: Date.now() + 60000 } } }));
  let requested = false;
  let ended = false;
  const unused = async () => { throw new Error('not used by this scenario'); };
  const computers = agentComputers({ records: () => records, idleSeconds: 60, seed: unused,
    browser: () => ({ browserId: 'browser', start: unused,
      control: async () => { if (ended) throw new BrowserSessionEnded('terminated'); return 'agent'; },
      stop: async () => { requested = true; }, automationStream: unused, screenshot: unused, beforeProfileSave: unused,
      createProfile: unused, saveProfile: unused, deleteProfile: unused, handBack: unused }),
    files: () => { throw new Error('teardown must not mount Files'); } });
  const stopped = execution.finish([() => computers.stopThread('owner', 'side')], true);
  await vi.waitFor(() => expect(requested).toBe(true));
  await expect(new ScheduledExecution(table, documents).acquire('other', 'next')).rejects.toThrow('occupied');
  ended = true;
  await stopped;
  await expect(records.runningAgentComputer('owner', 'side')).resolves.toBeNull();
  await new ScheduledExecution(table, documents).acquire('other', 'next');
});

it('refuses an untagged legacy start without a Browser receipt', async () => {
  const execution = new ScheduledExecution(table, documents);
  const records = new AccountResources(table, documents);
  await execution.acquire('owner', 'side');
  await documents.send(new PutCommand({ TableName: table, Item: { pk: 'AGENT_COMPUTER_RUNNING', sk: 'owner#side',
    record: { accountId: 'owner', threadId: 'side', sessionId: null, phase: 'starting', idleDeadline: 0 } } }));
  const computers = agentComputers({ records: () => records, idleSeconds: 60, seed: async () => {},
    browser: () => { throw new Error('unknown receipt cannot be stopped'); }, files: () => { throw new Error('no mount'); } });
  await expect(execution.finish([() => computers.stopThread('owner', 'side')], true)).rejects.toThrow('teardown is unproved');
  await expect(new ScheduledExecution(table, documents).acquire('other', 'next')).rejects.toThrow('occupied');
});

it('attempts both teardowns and retains capacity when either is unproved', async () => {
  const execution = new ScheduledExecution(table, documents);
  await execution.acquire('owner', 'side');
  const primary = new Error('stream failed');
  const stopFailure = new Error('Runtime stop unproved');
  let browserStopped = false;
  await expect(execution.finish([
    async () => { throw stopFailure; }, async () => { browserStopped = true; },
  ], true, primary)).rejects.toMatchObject({ errors: [primary, stopFailure] });
  expect(browserStopped).toBe(true);
  await expect(new ScheduledExecution(table, documents).acquire('other', 'next')).rejects.toThrow('occupied');
});
