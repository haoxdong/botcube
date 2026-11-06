import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_ARN } from '../test/fakes/stack.js';
import { defined } from '../test/defined.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import type { AgentDocuments } from './agent-documents.js';
import { DynamoDBAgentDocuments } from './agent-documents.js';
import type { ChatServiceCartridge } from './cartridge.js';
import { runScheduledTask, sqsRunQueue } from './scheduled-runs.js';
import { ScheduledTasks, type ScheduledRunMessage } from './scheduled-tasks.js';
import { sessionApi, type SessionApi } from './session-api.js';
import { sessionLifecycle } from './session-lifecycle.js';
import { DynamoDBSessionMetadata, SessionBusyError, SessionDeletedError, type SessionMetadata } from './session-metadata.js';
import { agentCoreUpstream } from './upstream.js';

import { owner, stack, stream, text } from '../test/scheduled-run-fixture.js';
import { motoAws } from '../test/fakes/moto.js';

function interruptReservation(store: NonNullable<SessionMetadata['scheduledRuns']>, failure: string, entered: () => void, released: Promise<void>) {
  const claim = store.claim.bind(store);
  return vi.spyOn(store, 'claim').mockImplementation(async (...args) => {
    const delivery = await claim(...args);
    if (failure === 'before preparation') throw new Error('Replacement before preparation');
    if (failure === 'after admission') {
      await store.admit(delivery);
      throw new Error('Replacement after admission');
    }
    if (failure === 'Claim before admission') await stack.history.transfer(delivery.owner, owner());
    if (failure === 'paused reservation') { entered(); await released; }
    return delivery;
  });
}

async function seedSettledFailedDelivery(metadata: SessionMetadata, account: string, taskId: string, deliveryId: string): Promise<void> {
  const store = defined(metadata.scheduledRuns, 'scheduled delivery store');
  const main = await metadata.mainChat(account, `filed-${account}`);
  const delivery = await store.claim(account, taskId, deliveryId, `filed-${account}`, main, taskId);
  await store.admit(delivery);
  await metadata.recordTurn(account, main, { filingUserId: `filed-${account}`, title: 'Brief', messageId: delivery.postMessageId, postAcceptance: true });
  const complete = await metadata.beginDispatch(account, main, undefined, { messageId: delivery.postMessageId });
  const posting = await store.posting(delivery, complete, true);
  await defined(complete.markSucceeded, 'registered post success proof')('session-post', store.postedTransaction(posting));
  await complete();
  await store.complete(posting);
  await store.retryFailed(posting);
}

async function changeReservedClaimBoundary(claimed: InProcessStack, boundary: string, source: string, destination: string, taskId: string, originalMain: string, sameOwner: boolean): Promise<void> {
  if (boundary === 'deleted destination') await claimed.sessionMetadata.fenceOwner(destination);
  if (boundary === 'further Claim') await claimed.history.transfer(destination, owner());
  if (boundary === 'changed source Claim') await DynamoDBDocumentClient.from(claimed.table.client).send(new PutCommand({ TableName: claimed.table.name,
    Item: { pk: `SESSIONS#${source}`, sk: 'CLAIM', destination: owner() } }));
  if (boundary === 'missing moved task' || boundary === 'paused moved task' || sameOwner) {
    const changed = await claimed.app.request(`/scheduled-tasks/${taskId}`, { method: boundary.startsWith('missing') ? 'DELETE' : 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-owner': sameOwner ? source : destination },
      ...(boundary.startsWith('paused') ? { body: JSON.stringify({ paused: true }) } : {}) });
    expect(changed.status).toBe(boundary.startsWith('missing') ? 204 : 200);
  }
  if (boundary === 'missing original Main') await DynamoDBDocumentClient.from(claimed.table.client).send(new DeleteCommand({ TableName: claimed.table.name,
    Key: { pk: `SESSIONS#${destination}`, sk: `SESSION#${originalMain}` } }));
}

describe('scheduled persistence dispatch admission', () => {
  it('runs one first occurrence while an overlapping occurrence skips and stays skipped on redelivery', async () => {
    const isolated = await startInProcess({ scheduled: true, scheduledDraining: async () => true });
    const account = owner();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let first: Promise<void[]> | undefined;
    try {
      const response = await isolated.app.request('/scheduled-tasks', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': account },
        body: JSON.stringify({ title: 'Morning brief', prompt: 'Check the curve', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'curve' }),
      });
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      const runs = defined(isolated.scheduler, 'scheduled stack');
      const tasks = new ScheduledTasks(isolated.table.name, runs.runs, isolated.table.client,
        new SchedulerClient(motoAws()));
      const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: isolated.agentcore.url });
      const cartridge: ChatServiceCartridge = {
        corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
        routes: new Hono(), requester: async () => ({ owner: account }), scheduledRequester: async (owner) => ({ owner }),
        filingUserId: (owner) => `filed-${owner}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
        credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
      };
      const deps = { turnIdentity: null, cartridge, sessionMetadata: isolated.sessionMetadata,
        agentDocuments: new DynamoDBAgentDocuments(isolated.table.name, isolated.table.client), scheduledTasks: tasks,
        upstream: sessionLifecycle(runtime, runtime.stop), invokeSessionApi: sessionApi({ localUrl: isolated.sessionApi.url }),
        summarizeTurn: async () => ({ title: 'Brief', summary: 'Checked the curve.' }),
      };
      isolated.agentcore.scriptPrompt('Check the curve', { ...stream(...text('brief', 'Rates rose.')), hold });
      const original = { owner: account, taskId: id, deliveryId: 'first-occurrence' };
      const overlapping = { owner: account, taskId: id, deliveryId: 'overlapping-occurrence' };
      const deliveries = [runScheduledTask(deps, original), runScheduledTask(deps, overlapping)];
      first = Promise.all(deliveries);
      await Promise.race(deliveries);
      expect(isolated.agentcore.invocations()).toHaveLength(1);
      const posts = () => isolated.sessionApi.events().filter((event) => event.operation === 'post');
      expect(posts()).toEqual([expect.objectContaining({ content: 'Scheduled task "Morning brief" skipped: the previous run was still going' })]);
      release();
      await first;
      await runScheduledTask(deps, overlapping);
      await runScheduledTask(deps, original);
      expect(isolated.agentcore.invocations()).toHaveLength(1);
      expect(posts()).toEqual([
        expect.objectContaining({ content: 'Scheduled task "Morning brief" skipped: the previous run was still going' }),
        expect.objectContaining({ content: 'Scheduled task "Morning brief": Rates rose.' }),
      ]);
      const threads = await (await isolated.app.request('/threads', { headers: { 'x-test-owner': account } })).json() as { threads: { title: string }[] };
      expect(threads.threads).toEqual([expect.objectContaining({ title: 'Morning brief' })]);
    } finally {
      release();
      await first;
      await isolated.stop();
    }
  });

  it('keeps a task made one-off after a recurring run was queued, until its own time comes', async () => {
    const isolated = await startInProcess({ scheduled: true, scheduledDraining: async () => true });
    try {
      const account = owner();
      const call = (method: string, path: string, body: unknown) => isolated.app.request(path, { method,
        headers: { 'content-type': 'application/json', 'x-test-owner': account }, body: JSON.stringify(body) });
      const { id } = await (await call('POST', '/scheduled-tasks', {
        title: 'Payrolls', prompt: 'Preview payrolls', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'payrolls-made-once',
      })).json() as { id: string };
      const runs = defined(isolated.scheduler, 'scheduled stack');
      const tasks = new ScheduledTasks(isolated.table.name, runs.runs, isolated.table.client,
        new SchedulerClient(motoAws()));
      const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: isolated.agentcore.url });
      const cartridge: ChatServiceCartridge = {
        corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
        routes: new Hono(), requester: async () => ({ owner: account }), scheduledRequester: async (owner) => ({ owner }),
        filingUserId: (owner) => `filed-${owner}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
        credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
      };
      const deps = { turnIdentity: null, cartridge, sessionMetadata: isolated.sessionMetadata,
        agentDocuments: new DynamoDBAgentDocuments(isolated.table.name, isolated.table.client), scheduledTasks: tasks,
        upstream: sessionLifecycle(runtime, runtime.stop), invokeSessionApi: sessionApi({ localUrl: isolated.sessionApi.url }),
        summarizeTurn: async () => ({ title: 'Payrolls', summary: 'Previewed payrolls.' }),
      };
      isolated.agentcore.scriptPrompt('Preview payrolls', stream(...text('payrolls', 'Payrolls beat.')));
      // The daily run is already queued when the user makes the task run once, next year.
      await call('PATCH', `/scheduled-tasks/${id}`, { schedule: `at(${new Date().getUTCFullYear() + 1}-11-06T13:30:00)` });

      await runScheduledTask(deps, { owner: account, taskId: id, deliveryId: 'queued-daily-occurrence' });

      expect(await tasks.get(account, id)).not.toBeNull();
    } finally {
      await isolated.stop();
    }
  });

  it("retires a one-off on its redelivery when retiring failed after its run's post", async () => {
    const isolated = await startInProcess({ scheduled: true, scheduledDraining: async () => true });
    try {
      const account = owner();
      const response = await isolated.app.request('/scheduled-tasks', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': account },
        body: JSON.stringify({ title: 'Payrolls', prompt: 'Preview payrolls', schedule: 'at(2026-10-02T13:30:00)', timezone: 'UTC', proposalId: 'payrolls' }),
      });
      const { id } = await response.json() as { id: string };
      const runs = defined(isolated.scheduler, 'scheduled stack');
      const tasks = new ScheduledTasks(isolated.table.name, runs.runs, isolated.table.client,
        new SchedulerClient(motoAws()));
      const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: isolated.agentcore.url });
      const cartridge: ChatServiceCartridge = {
        corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
        routes: new Hono(), requester: async () => ({ owner: account }), scheduledRequester: async (owner) => ({ owner }),
        filingUserId: (owner) => `filed-${owner}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
        credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
      };
      // Storage refuses the first retirement, as a throttled transaction would.
      let refusals = 1;
      const retire: ScheduledTasks['retire'] = async (...args) => {
        if (refusals-- > 0) throw new Error('Retirement throttled');
        return tasks.retire(...args);
      };
      const deps = { turnIdentity: null, cartridge, sessionMetadata: isolated.sessionMetadata,
        agentDocuments: new DynamoDBAgentDocuments(isolated.table.name, isolated.table.client), scheduledTasks: { get: tasks.get.bind(tasks), recordRun: tasks.recordRun.bind(tasks), retire, issueSideChat: tasks.issueSideChat.bind(tasks) },
        upstream: sessionLifecycle(runtime, runtime.stop), invokeSessionApi: sessionApi({ localUrl: isolated.sessionApi.url }),
        summarizeTurn: async () => ({ title: 'Payrolls', summary: 'Previewed payrolls.' }),
      };
      isolated.agentcore.scriptPrompt('Preview payrolls', stream(...text('payrolls', 'Payrolls beat.')));
      const delivery = { owner: account, taskId: id, deliveryId: 'one-off-occurrence' };

      await expect(runScheduledTask(deps, delivery)).rejects.toThrow('Retirement throttled');
      expect(await tasks.get(account, id)).not.toBeNull();
      await runScheduledTask(deps, delivery);

      expect(await tasks.get(account, id)).toBeNull();
      expect(isolated.agentcore.invocations()).toHaveLength(1);
      expect(isolated.sessionApi.events().filter((event) => event.operation === 'post')).toEqual([
        expect.objectContaining({ content: 'Scheduled task "Payrolls": Payrolls beat.' }),
      ]);
    } finally {
      await isolated.stop();
    }
  });

  it.each(['valid transfer', 'original Main filing', 'missing original Main filing proof', 'concurrent replacements', 'deleted destination', 'further Claim', 'changed source Claim', 'missing moved task', 'paused moved task', 'missing original Main', 'fresh source delivery', 'missing same-owner task', 'paused same-owner task'] as const)('recovers the original reserved SQS delivery after its real scheduled task moves during Account Claim: %s', async (boundary) => {
    const claimed = await startInProcess({ scheduled: true, scheduledDraining: async () => true });
    const source = owner();
    const destination = owner();
    const runs = defined(claimed.scheduler, 'the Claim stack schedules tasks');
    const tasks = new ScheduledTasks(claimed.table.name, runs.runs, claimed.table.client,
      new SchedulerClient(motoAws()));
    const response = await claimed.app.request('/scheduled-tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': source },
      body: JSON.stringify({ title: 'Reserved Claim', prompt: 'Preserve this occurrence', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'reserved-claim-proof' }) });
    expect(response.status).toBe(201);
    const { id: taskId } = await response.json() as { id: string };
    const originalMainFiling = boundary === 'original Main filing' ? 'original-filing' : `filed-${source}`;
    const originalMain = await claimed.sessionMetadata.mainChat(source, originalMainFiling);
    const destinationMain = await claimed.sessionMetadata.mainChat(destination, `filed-${destination}`);
    claimed.agentcore.scriptPrompt('Preserve this occurrence', stream(...text('reserved-answer', 'Recovered original occurrence.')));
    const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: claimed.agentcore.url });
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
      models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
      routes: new Hono(), requester: async () => ({ owner: source }), scheduledRequester: async (account) => ({ owner: account }),
      filingUserId: (account) => `filed-${account}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const deps = { turnIdentity: null, cartridge, sessionMetadata: claimed.sessionMetadata,
      agentDocuments: new DynamoDBAgentDocuments(claimed.table.name, claimed.table.client), scheduledTasks: tasks,
      upstream: sessionLifecycle(runtime, runtime.stop), invokeSessionApi: sessionApi({ localUrl: claimed.sessionApi.url }),
      summarizeTurn: async () => ({ title: 'Reserved Claim', summary: 'Completed this occurrence.' }),
    };
    await runs.fire(taskId);
    const sqs = new SQSClient(motoAws());
    const queue = sqsRunQueue(runs.runs.queueUrl, sqs);
    const original = defined((await queue.receive(new AbortController().signal))[0], 'original SQS delivery');
    const message = { ...JSON.parse(original.body) as ScheduledRunMessage, deliveryId: original.deliveryId };
    const store = defined(claimed.sessionMetadata.scheduledRuns, 'original delivery store');
    const claim = store.claim.bind(store);
    const reservation = vi.spyOn(store, 'claim').mockImplementation(async (...args) => {
      const delivery = await claim(...args);
      if (boundary === 'missing same-owner task' || boundary === 'paused same-owner task') throw new Error('Interrupted before preparation');
      await claimed.history.transfer(source, destination);
      return delivery;
    });
    let restoreAdmission = () => {};
    try {
      await expect(runScheduledTask(deps, message)).rejects.toThrow();
      reservation.mockRestore();
      const sameOwner = boundary === 'missing same-owner task' || boundary === 'paused same-owner task';
      if (sameOwner) expect(await tasks.get(source, taskId)).toMatchObject({ id: taskId });
      else { expect(await tasks.get(source, taskId)).toBeNull(); expect(await tasks.get(destination, taskId)).toMatchObject({ id: taskId }); }
      const reserved = defined(await store.get(source, message.deliveryId, taskId), 'original reservation');
      expect(reserved).toMatchObject({ phase: 'reserved', mainChat: originalMain, filingUserId: `filed-${source}` });
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: runs.runs.queueUrl, ReceiptHandle: original.receipt, VisibilityTimeout: 0 }));
      const redelivery = defined((await queue.receive(new AbortController().signal))[0], 'replacement SQS delivery');
      expect(redelivery.deliveryId).toBe(original.deliveryId);
      const replacement = new DynamoDBSessionMetadata(claimed.table.name, claimed.table.client);
      const resume = () => runScheduledTask({ ...deps, sessionMetadata: replacement, upstream: sessionLifecycle(runtime, runtime.stop) },
        { ...JSON.parse(redelivery.body) as ScheduledRunMessage, deliveryId: redelivery.deliveryId });
      const validTransfer = boundary === 'valid transfer' || boundary === 'original Main filing';
      const admissionRace = boundary === 'changed source Claim' || boundary === 'deleted destination';
      if (admissionRace) {
        const replacementStore = defined(replacement.scheduledRuns, 'replacement delivery store');
        const admit = replacementStore.admit.bind(replacementStore);
        const mutation = vi.spyOn(replacementStore, 'admit').mockImplementationOnce(async (...args) => {
          await changeReservedClaimBoundary(claimed, boundary, source, destination, taskId, originalMain, sameOwner);
          await admit(...args);
        });
        restoreAdmission = () => { mutation.mockRestore(); };
      } else await changeReservedClaimBoundary(claimed, boundary, source, destination, taskId, originalMain, sameOwner);
      if (boundary === 'missing original Main filing proof') await DynamoDBDocumentClient.from(claimed.table.client).send(new UpdateCommand({
        TableName: claimed.table.name, Key: { pk: `SESSIONS#${source}`, sk: `SCHEDULED_DELIVERY#${message.deliveryId}` },
        UpdateExpression: 'REMOVE mainFilingUserId',
      }));
      if (boundary === 'fresh source delivery') {
        const freshId = `${message.deliveryId}-unreserved`;
        await runScheduledTask({ ...deps, sessionMetadata: replacement }, { ...message, deliveryId: freshId });
        expect(await defined(replacement.scheduledRuns, 'replacement delivery store').get(source, freshId, taskId)).toBeNull();
      } else if (sameOwner) await resume();
      else if (!validTransfer && boundary !== 'concurrent replacements') await expect(resume()).rejects.toThrow();
      if (!validTransfer && boundary !== 'concurrent replacements') {
        expect(claimed.agentcore.invocations()).toHaveLength(0);
        expect(claimed.sessionApi.events().filter((event) => event.operation === 'post')).toEqual([]);
        expect(await store.get(source, message.deliveryId, taskId)).toMatchObject({ phase: 'reserved', sideChat: reserved.sideChat, runId: reserved.runId });
        expect(await replacement.mainChat(destination, `filed-${destination}`)).toBe(destinationMain);
        return;
      }
      if (boundary === 'concurrent replacements') {
        const replacementStore = defined(replacement.scheduledRuns, 'replacement delivery store');
        const reclaim = replacementStore.reclaim.bind(replacementStore);
        let entered = () => {};
        let release = () => {};
        const paused = new Promise<void>((resolve) => { entered = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        const pausedAttempt = vi.spyOn(replacementStore, 'reclaim').mockImplementationOnce(async (...args) => {
          const next = await reclaim(...args); entered(); await released; return next;
        });
        const stale = resume();
        const refused = expect(stale).rejects.toThrow();
        try { await paused; await resume(); }
        finally { release(); pausedAttempt.mockRestore(); }
        await refused;
      } else await resume();
      await queue.delete(redelivery.receipt);
      expect(await runs.queued()).toBe(0);
      expect(await defined(replacement.scheduledRuns, 'replacement delivery store').get(source, message.deliveryId, taskId)).toMatchObject({ phase: 'completed', mainChat: originalMain, mainFilingUserId: originalMainFiling,
        sideChat: reserved.sideChat, runId: reserved.runId, postMessageId: reserved.postMessageId });
      await resume();
      expect(claimed.agentcore.invocations()).toHaveLength(1);
      expect(claimed.agentcore.invocationFor(reserved.sideChat).payload.forwardedProps.sessionUserId).toBe(`filed-${source}`);
      expect(await replacement.mainChat(destination, `filed-${destination}`)).toBe(destinationMain);
      expect(claimed.sessionApi.events().filter((event) => event.operation === 'post')).toEqual([expect.objectContaining({ sessionId: originalMain,
        userId: originalMainFiling, messageId: reserved.postMessageId, content: 'Scheduled task "Reserved Claim": Recovered original occurrence.' })]);
    } finally { restoreAdmission(); reservation.mockRestore(); await claimed.stop(); }
  });

  it.each(['deleted owner', 'Account Claim'] as const)('refuses a new durable delivery claim after %s', async (fence) => {
    const account = owner();
    const store = defined(stack.sessionMetadata.scheduledRuns, 'scheduled delivery store');
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    if (fence === 'deleted owner') await stack.sessionMetadata.fenceOwner(account);
    else await DynamoDBDocumentClient.from(stack.table.client).send(new PutCommand({ TableName: stack.table.name,
      Item: { pk: `SESSIONS#${account}`, sk: 'CLAIM', destination: owner() } }));
    await expect(store.claim(account, 'task', 'fenced-occurrence', `filed-${account}`, main, 'task')).rejects.toThrow();
    expect(await store.get(account, 'fenced-occurrence', 'task')).toBeNull();
  });

  it('retains one original durable delivery identity and refuses another task reusing it', async () => {
    const account = owner();
    const store = defined(stack.sessionMetadata.scheduledRuns, 'scheduled delivery store');
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    const original = await store.claim(account, 'task', 'same-occurrence', `filed-${account}`, main, 'task');
    await expect(store.claim(account, 'task', 'same-occurrence', `filed-${account}`, main, 'task')).rejects.toThrow();
    expect(await store.get(account, 'same-occurrence', 'task')).toMatchObject(original);
    await expect(store.get(account, 'same-occurrence', 'different-task')).rejects.toThrow('Scheduled delivery identity is invalid');
  });

  it('delivers a finished scheduled run and records its status after rejected Main writers recover', async () => {
    const account = owner();
    const task = { id: 'busy-main-result', proposalId: 'busy-main-result', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Saved answer"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn<SessionApi>(async () => ({}));
    const deps = {
      turnIdentity: null, summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed.' }),
      cartridge, sessionMetadata: stack.sessionMetadata,
      agentDocuments: { get: async () => templates, save: async () => undefined, delete: async () => undefined, picture: async () => null, savePicture: async () => undefined },
      scheduledTasks: { get: async () => task, recordRun: vi.fn(async () => undefined), retire: async () => undefined, issueSideChat: async () => task.id },
      upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-recovery-runtime', invoke }, async () => undefined), invokeSessionApi: post,
    };
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    await stack.sessionMetadata.recordTurn(account, main, { filingUserId: `filed-${account}`, title: 'Main', messageId: 'active-main' });
    const active = await stack.sessionMetadata.beginDispatch(account, main);
    await defined(active.markRejected, 'rejected writer')('scheduled-recovery-runtime');
    const message = { owner: account, taskId: task.id, deliveryId: 'busy-main-occurrence' };
    await runScheduledTask(deps, message);
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ scheduledRun: { status: 'done', text: 'Saved answer' } });
    expect(deps.scheduledTasks.recordRun).toHaveBeenCalledWith(account, task.id, { at: expect.any(String), status: 'done' });
    const next = await stack.sessionMetadata.beginDispatch(account, main);
    await next();
  });
  it('retains a completed scheduled answer through a failed writer recovery attempt', async () => {
    const account = owner();
    const task = { id: 'busy-main-result', proposalId: 'busy-main-result', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Saved answer"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn<SessionApi>(async () => ({}));
    const stop = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Temporary stop failure')).mockResolvedValue(undefined);
    const deps = {
      turnIdentity: null, summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed.' }),
      cartridge, sessionMetadata: stack.sessionMetadata,
      agentDocuments: { get: async () => templates, save: async () => undefined, delete: async () => undefined, picture: async () => null, savePicture: async () => undefined },
      scheduledTasks: { get: async () => task, recordRun: vi.fn(async () => undefined), retire: async () => undefined, issueSideChat: async () => task.id },
      upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-recovery-runtime', invoke }, stop), invokeSessionApi: post,
    };
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    await stack.sessionMetadata.recordTurn(account, main, { filingUserId: `filed-${account}`, title: 'Main', messageId: 'active-main' });
    const active = await stack.sessionMetadata.beginDispatch(account, main);
    await defined(active.markRejected, 'rejected writer')('scheduled-recovery-runtime');
    const message = { owner: account, taskId: task.id, deliveryId: 'busy-main-occurrence' };
    await runScheduledTask(deps, message);
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ scheduledRun: { status: 'done', text: 'Saved answer' } });
    expect(deps.scheduledTasks.recordRun).toHaveBeenCalledWith(account, task.id, { at: expect.any(String), status: 'done' });
    const next = await stack.sessionMetadata.beginDispatch(account, main);
    await next();
  });

  it.each([false, true])('holds a completed Side result while Main writers settle without fencing replacements (Claim: %s)', async (claim) => {
    const account = owner();
    const destination = owner();
    const task = { id: 'busy-main-result', proposalId: 'busy-main-result', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Saved answer"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn<SessionApi>(async () => ({}));
    const deps = {
      turnIdentity: null, summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed.' }),
      cartridge, sessionMetadata: stack.sessionMetadata,
      agentDocuments: { get: async () => templates, save: async () => undefined, delete: async () => undefined, picture: async () => null, savePicture: async () => undefined },
      scheduledTasks: { get: async () => task, recordRun: vi.fn(async () => undefined), retire: async () => undefined, issueSideChat: async () => task.id },
      upstream: sessionLifecycle({ label: 'AgentCore', invoke }), invokeSessionApi: post,
    };
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    await stack.sessionMetadata.recordTurn(account, main, { filingUserId: `filed-${account}`, title: 'Main', messageId: 'active-main' });
    const active = await stack.sessionMetadata.beginDispatch(account, main);
    const message = { owner: account, taskId: task.id, deliveryId: 'busy-main-occurrence' };
    let observeBusy!: () => void;
    let rejectBusy!: (error: unknown) => void;
    const busy = new Promise<void>((resolve, reject) => { observeBusy = resolve; rejectBusy = reject; });
    const dispatch = stack.sessionMetadata.beginDispatch.bind(stack.sessionMetadata);
    vi.spyOn(stack.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      try { return await dispatch(...args); }
      catch (error) {
        if (args[4] === 'session-post' && error instanceof SessionBusyError) observeBusy();
        throw error;
      }
    });
    const run = runScheduledTask(deps, message);
    void run.catch(rejectBusy);
    let replacement: Awaited<ReturnType<SessionMetadata['beginDispatch']>> | undefined;
    try {
      await busy;
      const store = defined(stack.sessionMetadata.scheduledRuns, 'delivery store');
      expect(await store.get(account, message.deliveryId, task.id)).toMatchObject({ phase: 'admitted' });
      expect(invoke).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
      await stack.sessionMetadata.recordTurn(account, main, { filingUserId: `filed-${account}`, title: 'New Main question', messageId: 'replacement-main' });
      replacement = await stack.sessionMetadata.beginDispatch(account, main);
      if (claim) await stack.history.transfer(account, destination);
      await active();
      await replacement();
      await run;
      expect(invoke).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
      expect(post.mock.calls[0]?.[0]).toMatchObject({ userId: `filed-${account}`, scheduledRun: { text: 'Saved answer' } });
      expect(deps.scheduledTasks.recordRun).toHaveBeenCalledWith(claim ? destination : account, task.id, { at: expect.any(String), status: 'done' });
      expect(await store.get(account, message.deliveryId, task.id)).toMatchObject({ phase: 'completed' });
    } finally {
      await Promise.all([active(), replacement?.()]);
      await run;
    }
  });


  it.each(['ack failure', 'success proof failure', 'uncertain post', 'failed run', 'settled failed retry', 'before preparation', 'running Main', 'paused reservation', 'after admission', 'Claim before admission'] as const)('recovers an accepted scheduled post on replacement without another Side Chat or Main result: %s', async (failure) => {
    const account = owner();
    const task = { id: 'post-recovery', proposalId: 'post-recovery', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined,
      warmSession: async () => undefined,
    };
    const documents: AgentDocuments = {
      get: async () => templates, save: async () => undefined, delete: async () => undefined,
      picture: async () => null, savePicture: async () => undefined,
    };
    const invoke = vi.fn(async () => {
      if (failure === 'failed run' || failure === 'settled failed retry') throw new Error('Model invocation failed');
      return new Response('data: {"type":"RUN_FINISHED"}\n\n');
    });
    const post = vi.fn(async () => {
      if (failure === 'uncertain post') throw new Error('Post outcome unavailable');
      return {};
    });
    const deps = {
      turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun: async () => undefined, retire: async () => undefined, issueSideChat: async () => task.id },
      upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-fixture-runtime', invoke }, async () => undefined),
      invokeSessionApi: post,
    };
    const begin = stack.sessionMetadata.beginDispatch.bind(stack.sessionMetadata);
    const registration = vi.spyOn(stack.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      const complete = await begin(...args);
      if (failure !== 'settled failed retry' && args[3] && 'messageId' in args[3]) {
        if (failure === 'success proof failure') {
          complete.markSucceeded = async () => { throw new Error('Success proof unavailable'); };
          return complete;
        }
        return Object.assign(async () => { throw new Error('Dispatch acknowledgement unavailable'); }, complete);
      }
      return complete;
    });
    const message = { owner: account, taskId: task.id, deliveryId: 'stable-sqs-occurrence' };
    const store = defined(stack.sessionMetadata.scheduledRuns, 'scheduled delivery store');
    let mainRunningSnapshot: unknown;
    if (failure === 'running Main') {
      const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
      await stack.sessionMetadata.recordTurn(account, main, { filingUserId: `filed-${account}`, title: 'Ordinary Main Chat', messageId: 'ordinary-main-message', running: { runId: 'ordinary-main-run', startedAt: '2026-10-09T00:00:00Z' } });
      invoke.mockImplementation(async () => {
        mainRunningSnapshot = await stack.sessionMetadata.get(account, main);
        return new Response('data: {"type":"RUN_FINISHED"}\n\n');
      });
    }
    let enteredReservation!: () => void;
    const reservationEntered = new Promise<void>((resolve) => { enteredReservation = resolve; });
    let releaseReservation!: () => void;
    const reservationReleased = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const reservation = interruptReservation(store, failure, enteredReservation, reservationReleased);
    if (failure === 'paused reservation') {
      const recording = vi.spyOn(stack.sessionMetadata, 'recordTurn');
      const original = runScheduledTask(deps, message);
      void original.catch(() => undefined);
      try {
        await reservationEntered;
        const unrelatedOwner = owner();
        const unrelatedMain = await stack.sessionMetadata.mainChat(unrelatedOwner, `filed-${unrelatedOwner}`);
        await stack.sessionMetadata.recordTurn(unrelatedOwner, unrelatedMain, {
          filingUserId: `filed-${unrelatedOwner}`, title: 'Unrelated Turn', messageId: randomUUID(),
        });
        const reserved = defined(await store.get(account, message.deliveryId, task.id), 'original reservation');
        const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
        await runScheduledTask({ ...deps, sessionMetadata: replacement,
          upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-fixture-runtime', invoke }, async () => undefined) }, message);
        const completed = await defined(replacement.scheduledRuns, 'replacement delivery store').get(account, message.deliveryId, task.id);
        expect(completed).toMatchObject({ phase: 'completed', sideChat: reserved.sideChat, mainChat: reserved.mainChat, runId: reserved.runId, postMessageId: reserved.postMessageId });
        releaseReservation();
        await expect(original).rejects.toThrow();
        expect(recording.mock.calls.filter(([recordOwner]) => recordOwner === account)).toEqual([]);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledTimes(1);
      } finally {
        releaseReservation(); await original.catch(() => undefined);
        recording.mockRestore(); registration.mockRestore(); reservation.mockRestore();
      }
      return;
    }
    const expectedErrors = {
      'ack failure': 'Dispatch acknowledgement unavailable', 'success proof failure': 'Success proof unavailable',
      'uncertain post': 'Post outcome unavailable', 'failed run': 'Dispatch acknowledgement unavailable',
      'settled failed retry': 'Model invocation failed',
      'before preparation': 'Replacement before preparation', 'running Main': 'Dispatch acknowledgement unavailable',
      'after admission': 'Replacement after admission',
      'Claim before admission': 'Transaction',
    };
    let settledRetry: unknown;
    let restoreFailedRetry = () => {};
    if (failure === 'settled failed retry') {
      await seedSettledFailedDelivery(stack.sessionMetadata, account, task.id, message.deliveryId);
      const reset = store.retryFailed.bind(store);
      const completed = vi.spyOn(store, 'retryFailed').mockImplementation(async (record) => {
        settledRetry = await store.get(account, message.deliveryId, task.id);
        await reset(record);
      });
      restoreFailedRetry = () => { completed.mockRestore(); };
    }
    try {
      await expect(runScheduledTask(deps, message)).rejects.toThrow(expectedErrors[failure]);
    } finally { restoreFailedRetry(); registration.mockRestore(); reservation.mockRestore(); }
    if (failure === 'settled failed retry') {
      expect(invoke).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledTimes(1);
      expect(settledRetry).toMatchObject({ phase: 'completed', failed: true });
      expect(await store.get(account, message.deliveryId, task.id)).toBeNull();
      return;
    }
    if (failure === 'Claim before admission') {
      const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
      await runScheduledTask({ ...deps, sessionMetadata: replacement }, message);
      expect(invoke).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledTimes(1);
      return;
    }
    if (failure === 'after admission') {
      const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
      await expect(runScheduledTask({ ...deps, sessionMetadata: replacement }, message)).rejects.toThrow('Scheduled delivery outcome is unproved');
      expect(invoke).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      return;
    }
    if (failure === 'running Main') expect(mainRunningSnapshot).toMatchObject({ turn_run_id: 'ordinary-main-run', turn_latest_run_id: 'ordinary-main-run', turn_running_since: '2026-10-09T00:00:00Z' });
    if (failure === 'before preparation') {
      expect(invoke).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
      await runScheduledTask({ ...deps, sessionMetadata: replacement,
        upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-fixture-runtime', invoke }, async () => undefined) }, message);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
      return;
    }
    expect(post).toHaveBeenCalledTimes(1);
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    const address = defined(await stack.sessionMetadata.get(account, main), 'accepted Main result');
    if (failure === 'success proof failure' || failure === 'uncertain post') {
      await expect(stack.sessionMetadata.assertNoDispatch(address)).rejects.toThrow('Session dispatch is still registered');
    } else await expect(stack.sessionMetadata.assertNoDispatch(address)).resolves.toBeUndefined();
    const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
    const retry = () => runScheduledTask({ ...deps, sessionMetadata: replacement,
      upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-fixture-runtime', invoke }, async () => undefined) }, message);
    if (failure === 'success proof failure' || failure === 'uncertain post') {
      await expect(retry()).rejects.toThrow('Scheduled delivery outcome is unproved');
    } else if (failure === 'failed run') {
      await expect(retry()).rejects.toThrow('Scheduled delivery previously failed');
      expect(await store.get(account, message.deliveryId, task.id)).toBeNull();
    }
    else { await retry(); await retry(); }
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    if (failure === 'success proof failure' || failure === 'uncertain post') {
      await expect(replacement.assertNoDispatch(address)).rejects.toThrow('Session dispatch is still registered');
    } else await expect(replacement.assertNoDispatch(address)).resolves.toBeUndefined();
  });

  it("records a run's end on redelivery when recording it failed after its Main Chat post", async () => {
    const account = owner();
    const task = { id: 'record-retry', proposalId: 'record-retry', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined,
      warmSession: async () => undefined,
    };
    const documents: AgentDocuments = {
      get: async () => templates, save: async () => undefined,
      delete: async () => undefined,
      picture: async () => null, savePicture: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"a1","delta":"Done."}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const recordRun = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('Task table unavailable'));
    const post = vi.fn(async () => ({}));
    const deps = {
      turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun, retire: async () => undefined, issueSideChat: async () => task.id },
      upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-fixture-runtime', invoke }, async () => undefined),
      invokeSessionApi: post,
    };
    const message = { owner: account, taskId: task.id, deliveryId: 'record-retry-occurrence' };

    await expect(runScheduledTask(deps, message)).rejects.toThrow('Task table unavailable');
    await runScheduledTask(deps, message);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledTimes(2);
    expect(recordRun).toHaveBeenLastCalledWith(account, task.id, { at: expect.any(String), status: 'done' });
  });

  it('propagates account deletion during scheduled preparation without posting to Main Chat', async () => {
    const account = owner();
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }),
      scheduledRequester: async (value) => {
        await stack.sessionMetadata.fenceOwner(value);
        return { owner: value };
      },
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined,
      warmSession: async () => undefined,
    };
    const documents: AgentDocuments = {
      get: async () => templates, save: async () => undefined, delete: async () => undefined,
      picture: async () => null, savePicture: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn(async () => ({}));
    await expect(runScheduledTask({
      turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => ({ id: 'deleted-run', proposalId: 'deleted-proposal', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false }), recordRun: async () => undefined, retire: async () => undefined, issueSideChat: async () => 'deleted-run' },
      upstream: sessionLifecycle({ label: 'AgentCore', invoke }, async () => undefined),
      invokeSessionApi: post,
    }, { owner: account, taskId: 'deleted-run', deliveryId: 'deleted-run-occurrence' })).rejects.toThrow(SessionDeletedError);
    expect(invoke).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps account deletion blocked until the scheduled Main Chat post finishes', async () => {
    const account = owner();
    const task = { id: 'scheduled-dispatch', proposalId: 'proposal-dispatch', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined,
      warmSession: async () => undefined,
    };
    const documents: AgentDocuments = {
      get: async () => templates, save: async () => undefined, delete: async () => undefined,
      picture: async () => null, savePicture: async () => undefined,
    };
    let posting: string | undefined;
    let enteredPost: (() => void) | undefined;
    const postEntered = new Promise<void>((resolve) => { enteredPost = resolve; });
    let finish: (() => void) | undefined;
    const run = runScheduledTask({
      turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun: async () => undefined, retire: async () => undefined, issueSideChat: async () => task.id },
      upstream: sessionLifecycle({ label: 'AgentCore', invoke: async () => new Response('data: {"type":"RUN_FINISHED"}\n\n') }, async () => undefined),
      invokeSessionApi: async (event) => {
        if (event.operation === 'post') {
          posting = event.sessionId;
          await new Promise<void>((resolve) => {
            finish = resolve;
            defined(enteredPost, 'post entry')();
          });
        }
        return {};
      },
    }, { owner: account, taskId: task.id, deliveryId: 'pending-post-occurrence' });
    await Promise.race([postEntered, run.then(() => { throw new Error('Scheduled run finished without posting to Main Chat'); })]);
    const sessionId = defined(posting, 'scheduled Main Chat');
    const address = defined(await stack.sessionMetadata.get(account, sessionId), 'scheduled Main Chat metadata');
    await stack.sessionMetadata.fenceOwner(account);
    await expect(stack.sessionMetadata.assertNoDispatch(address)).rejects.toThrow('Session dispatch is still registered');
    defined(finish, 'post completion')();
    await run;
    await expect(stack.sessionMetadata.assertNoDispatch(address)).resolves.toBeUndefined();
  });
});
