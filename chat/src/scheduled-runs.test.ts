import { randomUUID } from 'node:crypto';
import { DescribeTasksCommand, ECSClient, type DescribeTasksCommandOutput } from '@aws-sdk/client-ecs';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from '../test/fakes/credentials.js';
import type { UpstreamScript } from '../test/fakes/fake-agentcore.js';
import { SchedulerView, createScheduledRuns } from '../test/fakes/scheduler.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { ecsTaskDraining, pollScheduledRuns, runScheduledTask, sqsRunQueue, type RunQueue } from './scheduled-runs.js';
import { ScheduledTasks, type ScheduledRunMessage } from './scheduled-tasks.js';
import { DynamoDBAgentDocuments } from './agent-documents.js';
import { agentCoreUpstream } from './upstream.js';
import { sessionApi } from './session-api.js';
import { RUNTIME_ARN } from '../../../tests/chat/fakes/stack.js';
import { DynamoDBSessionMetadata, SessionDeletedError, type SessionMetadata } from './session-metadata.js';
import { Hono } from 'hono';
import { sessionLifecycle } from './session-lifecycle.js';
import type { AgentDocuments } from './agent-documents.js';
import type { AgentModel, ChatServiceCartridge } from './cartridge.js';

const signInChecks: { owner: string; outputs: string[] }[] = [];
/** Owners whose plan catalog cannot be fetched for their scheduled runs. */
const unavailableCatalogs = new Set<string>();
const turnSecrets = {
  files: { accessKeyId: 'scheduled-access-key', secretAccessKey: 'scheduled/secret+key', sessionToken: 'scheduled-session-token' },
  credentialServiceInvocationToken: 'scheduled-invocation-token',
  agentComputerCdpUrl: 'https://computer.example/cdp?token=scheduled-cdp-token',
};
let stack: InProcessStack;
let scheduler: SchedulerView;
beforeAll(async () => {
  stack = await startInProcess({
    scheduled: true,
    cartridge: {
      credentialProps: ['credentialServiceInvocationToken', 'agentComputerCdpUrl'],
      // A scheduled run acts for its owner with no request: say so in the payload.
      scheduledRequester: async (owner) => ({ owner, scheduled: true }),
      accountModels: async (requester) => {
        if ('scheduled' in requester && unavailableCatalogs.has(requester.owner)) throw new Error('The plan catalog is unavailable');
        return [{ key: 'plan', label: 'Plan', provider: 'openai' }];
      },
      invocationPayload: async (input, requester, model?: AgentModel) => ({
        ...input, forwardedProps: { ...input.forwardedProps, requester, approvedModel: model, ...turnSecrets },
      }),
      signInNeeded: async (owner, outputs) => {
        signInChecks.push({ owner, outputs });
        return outputs.find((output) => output.includes('Sign in to continue')) ?? null;
      },
    },
  });
  scheduler = defined(stack.scheduler, 'the stack schedules tasks');
});
afterAll(() => stack.stop());

const owner = () => `owner-${Math.random().toString(36).slice(2)}`;

const request = (account: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  stack.app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-test-owner': account },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** Confirm a task whose prompt the fake AgentCore answers with this script, edit in any model chosen, and fire its schedule. */
async function run(account: string, script: UpstreamScript, title = 'Morning brief', chosen: { model?: string } = {}): Promise<{ id: string; prompt: string }> {
  const prompt = `Brief me ${Math.random().toString(36).slice(2)}`;
  stack.agentcore.scriptPrompt(prompt, script);
  const response = await request(account, '/scheduled-tasks', {
    method: 'POST',
    body: { title, prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt, ...chosen },
  });
  const { id } = (await response.json()) as { id: string };
  await scheduler.fire(id);
  return { id, prompt };
}

/** The account's Activity, each task's completion time checked to fall after `started` and then left out. */
async function activity(account: string, started: number): Promise<Record<string, unknown>[]> {
  const { tasks } = (await (await request(account, '/activity')).json()) as { tasks: { completedAt: string }[] };
  return tasks.map(({ completedAt, ...task }) => {
    expect(Date.parse(completedAt)).toBeGreaterThanOrEqual(started);
    return task;
  });
}

async function mainChat(account: string): Promise<string> {
  return ((await (await request(account, '/main-chat')).json()) as { id: string }).id;
}

/**
 * What has been posted to the Session, once the first post is in: a run's post is its last step. Only the test's
 * timeout bounds the wait, since a loaded machine can take longer than any fixed deadline.
 */
async function posted(sessionId: string, api: InProcessStack['sessionApi'] = stack.sessionApi): Promise<{ content: string; userId: string }[]> {
  for (;;) {
    const posts = api
      .events()
      .flatMap((event) =>
        event.operation === 'post' && event.sessionId === sessionId ? [{ content: event.content ?? '', userId: event.userId }] : [],
      );
    if (posts.length > 0) return posts;
    // eslint-disable-next-line no-await-in-loop -- polls until the queued run is done
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const stream = (...frames: (object | string)[]): Extract<UpstreamScript, { kind: 'stream' }> => ({
  kind: 'stream',
  frames: [{ type: 'RUN_STARTED' }, ...frames, { type: 'RUN_FINISHED' }].map((frame) =>
    typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}`,
  ),
});

const text = (messageId: string, ...deltas: string[]) => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  ...deltas.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta })),
  { type: 'TEXT_MESSAGE_END', messageId },
];

describe('a scheduled run', () => {
  it('keeps an older per-run Side Chat when an existing task next runs in its task chat', async () => {
    const account = owner();
    const main = await mainChat(account);
    const response = await request(account, '/scheduled-tasks', { method: 'POST', body: {
      title: 'Morning brief', prompt: 'Check the curve', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'legacy-task',
    } });
    const { id } = await response.json() as { id: string };
    const oldChat = `old-run-${account}`;
    const previous = await request(account, '/', { method: 'POST', body: {
      threadId: oldChat, runId: 'legacy-run', messages: [{ id: 'legacy-request', role: 'user', content: 'Morning brief' }],
      tools: [], context: [], state: {}, forwardedProps: { model: 'plan' },
    } });
    expect(previous.status).toBe(200);
    await previous.text();
    stack.agentcore.scriptPrompt('Check the curve', stream(...text('brief', 'Next brief.')));
    await scheduler.fire(id);
    await posted(main);
    const { threads } = await (await request(account, '/threads')).json() as { threads: { id: string; title: string }[] };
    expect(threads).toHaveLength(2);
    expect(threads).toContainEqual(expect.objectContaining({ id: oldChat, title: 'Morning brief' }));
    expect(threads.filter(({ id }) => id !== oldChat)).toEqual([expect.objectContaining({ title: 'Morning brief' })]);
  });

  it('refuses a user Turn while its task Side Chat has a scheduled Turn going', async () => {
    const account = owner();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const main = await mainChat(account);
    await run(account, { ...stream(...text('brief', 'Scheduled brief.')), hold });
    let side = '';
    try {
      await vi.waitFor(async () => {
        const { threads } = (await (await request(account, '/threads')).json()) as { threads: { id: string }[] };
        side = defined(threads[0], 'task Side Chat').id;
        expect(stack.agentcore.invocationFor(side).payload.threadId).toBe(side);
      });
      const response = await request(account, '/', { method: 'POST', body: {
        threadId: side, runId: 'overlapping-user', messages: [{ id: 'question', role: 'user', content: 'Discuss the brief' }],
        tools: [], context: [], state: {}, forwardedProps: { model: 'plan' },
      } });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ detail: 'The previous Turn is still going' });
      expect(stack.agentcore.invocationFor(side).payload.messages).toHaveLength(1);
    } finally {
      release();
      await posted(main);
    }
  });

  it('skips a scheduled run while the user is chatting in its Side Chat', async () => {
    const account = owner();
    const main = await mainChat(account);
    const { id } = await run(account, stream(...text('answer', 'First brief.')));
    await posted(main);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0));
    const { threads } = (await (await request(account, '/threads')).json()) as { threads: { id: string }[] };
    const side = defined(threads[0], 'task Side Chat').id;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    stack.agentcore.scriptPrompt('Discuss the brief', { ...stream(...text('reply', 'User reply.')), hold });
    const chatting = await request(account, '/', { method: 'POST', body: {
      threadId: side, runId: 'user-discussion', messages: [{ id: 'discussion', role: 'user', content: 'Discuss the brief' }],
      tools: [], context: [], state: {}, forwardedProps: { model: 'plan' },
    } });
    try {
      expect(chatting.status).toBe(200);
      await scheduler.fire(id);
      await vi.waitFor(async () => expect(await posted(main)).toContainEqual({
        content: 'Scheduled task "Morning brief" skipped: the previous run was still going', userId: `filed-${account}`,
      }));
      // Its request was never written, so its card has nothing to open.
      const skipped = stack.sessionApi.events().find((event) => event.operation === 'post' && event.sessionId === main && event.content?.includes('skipped'));
      expect(skipped && 'scheduledRun' in skipped && skipped.scheduledRun).toEqual({
        title: 'Morning brief', ranAt: expect.any(String), status: 'skipped', text: 'the previous run was still going',
      });
    } finally {
      release();
      await chatting.text();
    }
  });

  it("says whether a task's Side Chat exists: not before its first run, and once it has", async () => {
    const account = owner();
    const main = await mainChat(account);
    const listed = async () => ((await (await request(account, '/scheduled-tasks')).json()) as { tasks: { sideChat: boolean }[] }).tasks;
    const prompt = `Side chat ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('a1', 'Done.')));
    const created = await request(account, '/scheduled-tasks', {
      method: 'POST', body: { title: 'Side', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt },
    });
    const { id, sideChat } = (await created.json()) as { id: string; sideChat: boolean };
    expect(sideChat).toBe(false);
    expect((await listed()).map((task) => task.sideChat)).toEqual([false]);

    await scheduler.fire(id);
    await posted(main);

    expect((await listed()).map((task) => task.sideChat)).toEqual([true]);
    const edited = await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { title: 'Renamed' } });
    expect(await edited.json()).toMatchObject({ sideChat: true });
  });

  it('adds later runs to the task Side Chat and leaves it after deleting the task', async () => {
    const account = owner();
    const main = await mainChat(account);
    const { id } = await run(account, stream(...text('answer', 'The curve changed.')));
    await posted(main);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0));
    const threads = async () => ((await (await request(account, '/threads')).json()) as { threads: { id: string; title: string }[] }).threads.map(({ id, title }) => ({ id, title }));
    const first = await threads();
    expect(first).toEqual([expect.objectContaining({ title: 'Morning brief' })]);
    await scheduler.fire(id);
    await vi.waitFor(async () => expect((await posted(main)).length).toBe(2));
    expect(await threads()).toEqual(first);
    const invocations = stack.agentcore.invocations().map(({ body }) => JSON.parse(body) as { threadId: string; runId: string; messages: { id: string }[] })
      .filter(({ threadId }) => threadId === defined(first[0], 'task Side Chat').id);
    expect(invocations).toHaveLength(2);
    expect(new Set(invocations.map(({ runId }) => runId)).size).toBe(2);
    expect(new Set(invocations.flatMap(({ messages }) => messages.map(({ id }) => id))).size).toBe(2);
    expect(await activity(account, 0)).toHaveLength(2);
    await request(account, `/scheduled-tasks/${id}`, { method: 'DELETE' });
    expect(await threads()).toEqual(first);
  });

  it('retires a one-off task once it has run, freeing its place under the cap and keeping its Side Chat and run card', async () => {
    const account = owner();
    const main = await mainChat(account);
    const prompt = `Once ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('once', 'Payrolls beat.')));
    const confirmed = async (title: string, schedule: string, proposalId: string) =>
      request(account, '/scheduled-tasks', { method: 'POST', body: { title, prompt, schedule, timezone: 'UTC', proposalId } });
    // Its time has come: Scheduler delivers a one-off at or after it.
    const { id } = (await (await confirmed('Payrolls', 'at(2026-10-02T13:30:00)', `once-${prompt}`)).json()) as { id: string };
    for (let n = 1; n <= 9; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      expect((await confirmed(`Brief ${n}`, 'rate(1 day)', `${prompt}-${n}`)).status).toBe(201);
    }

    await scheduler.fire(id);

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Payrolls": Payrolls beat.']);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0));
    const { tasks } = (await (await request(account, '/scheduled-tasks')).json()) as { tasks: { id: string }[] };
    expect(tasks.map((task) => task.id)).not.toContain(id);
    expect((await confirmed('Brief 10', 'rate(1 day)', `${prompt}-10`)).status).toBe(201);
    const { threads } = (await (await request(account, '/threads')).json()) as { threads: { title: string }[] };
    expect(threads).toEqual([expect.objectContaining({ title: 'Payrolls' })]);
  });

  it('discards an old queued occurrence and invokes only the fenced post-cutover occurrence', async () => {
    const account = owner();
    const prompt = `Cutover ${randomUUID()}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('cutover', 'A bounded update.')));
    const response = await request(account, '/scheduled-tasks', { method: 'POST', body: {
      title: 'Cutover', prompt, schedule: 'rate(1 minute)', timezone: 'UTC', endDate: '2099-01-01T00:00:00.000Z', proposalId: prompt,
    } });
    const { id } = await response.json() as { id: string };
    await DynamoDBDocumentClient.from(stack.table.client).send(new UpdateCommand({
      TableName: stack.table.name, Key: { pk: `SCHEDULED#${account}`, sk: `TASK#${id}` },
      UpdateExpression: 'SET deliveryFence = :fence', ExpressionAttributeValues: { ':fence': 'frozen-cutover' },
    }));
    const before = stack.agentcore.invocations().length;
    await scheduler.fire(id);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0));
    expect(stack.agentcore.invocations()).toHaveLength(before);
    expect(await activity(account, 0)).toEqual([]);
    expect((await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: false } })).status).toBe(200);
    await scheduler.fire(id);
    await vi.waitFor(async () => expect(await activity(account, 0)).toHaveLength(1));
    expect(stack.agentcore.invocations()).toHaveLength(before + 1);
    await request(account, `/scheduled-tasks/${id}`, { method: 'DELETE' });
  });

  it.each(['reserved', 'completed'] as const)('handles a pre-cutover %s delivery without invoking it again', async (phase) => {
    const account = owner();
    const response = await request(account, '/scheduled-tasks', { method: 'POST', body: {
      title: 'Cutover', prompt: 'Cutover', schedule: 'rate(1 minute)', timezone: 'UTC', endDate: '2099-01-01T00:00:00.000Z', proposalId: account,
    } });
    const { id } = await response.json() as { id: string };
    const tasks = new ScheduledTasks(stack.table.name, scheduler.runs, stack.table.client,
      new SchedulerClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
    const main = await mainChat(account);
    const store = defined(stack.sessionMetadata.scheduledRuns, 'delivery store');
    const delivery = await store.claim(account, id, 'pre-cutover', `filed-${account}`, main);
    const documents = DynamoDBDocumentClient.from(stack.table.client);
    await documents.send(new UpdateCommand({
      TableName: stack.table.name, Key: { pk: `SCHEDULED#${account}`, sk: `TASK#${id}` },
      UpdateExpression: 'SET deliveryFence = :fence', ExpressionAttributeValues: { ':fence': 'frozen-cutover' },
    }));
    if (phase === 'completed') await documents.send(new UpdateCommand({
      TableName: stack.table.name, Key: { pk: `SESSIONS#${account}`, sk: 'SCHEDULED_DELIVERY#pre-cutover' },
      UpdateExpression: 'SET #phase = :phase, #status = :status, postSession = :session, postToken = :token, failed = :failed',
      ExpressionAttributeNames: { '#phase': 'phase', '#status': 'status' }, ExpressionAttributeValues: {
        ':phase': phase, ':status': 'done', ':failed': false, ':token': randomUUID(),
        ':session': { session_id: main, filing_user_id: `filed-${account}`, runtime_binding: `runtime-${randomUUID()}`, runtime_generation: 'tracked-v1' },
      },
    }));
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], browserEventName: 'test:browser', routes: new Hono(),
      accountModel: async () => undefined,
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn(async () => ({}));
    await runScheduledTask({
      runtimeNamespaceRequired: false, turnIdentity: null, cartridge, sessionMetadata: stack.sessionMetadata,
      agentDocuments: new DynamoDBAgentDocuments(stack.table.name, stack.table.client), scheduledTasks: tasks,
      summarizeTurn: async () => ({ title: 'Cutover', summary: 'Cutover' }),
      upstream: sessionLifecycle({ label: 'AgentCore', invoke }, async () => undefined), invokeSessionApi: post,
    }, { owner: account, taskId: id, deliveryId: delivery.deliveryId });
    expect(invoke).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(await store.get(account, delivery.deliveryId, id)).toMatchObject({ phase });
    const current = await tasks.get(account, id);
    if (phase === 'completed') expect(current?.lastRun).toEqual({ at: delivery.startedAt, status: 'done' });
    else expect(current).not.toHaveProperty('lastRun');
  });

  it.each(['expired', 'retired', 'elapsed'] as const)('rechecks an admitted delivery during setup when its window is %s (#3968)', async (state) => {
    const account = owner();
    const response = await request(account, '/scheduled-tasks', { method: 'POST', body: {
      title: 'US rates', prompt: 'US rates', schedule: 'rate(1 minute)', timezone: 'UTC', endDate: '2099-01-01T00:00:00.000Z', proposalId: account,
    } });
    const { id } = await response.json() as { id: string };
    const tasks = new ScheduledTasks(stack.table.name, scheduler.runs, stack.table.client,
      new SchedulerClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, browserEventName: 'test:browser', routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined,
      warmSession: async () => undefined,
    };
    const documents: AgentDocuments = {
      get: async () => templates, save: async () => undefined, delete: async () => undefined,
      picture: async () => null, savePicture: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Rates update."}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn<import('./session-api.js').SessionApi>(async () => ({}));
    const deps = {
      runtimeNamespaceRequired: false, turnIdentity: null,
      summarizeTurn: async () => ({ title: 'US rates', summary: 'Gave a rates update.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: tasks,
      upstream: sessionLifecycle({ label: 'AgentCore', invoke }, async () => undefined), invokeSessionApi: post,
    };
    const stale = runScheduledTask({ ...deps, cartridge: { ...cartridge, scheduledRequester: async (value) => {
      enter(); await released; return { owner: value };
    } } }, { owner: account, taskId: id, deliveryId: 'stale-admission' });
    try {
      await Promise.race([entered, stale.then(() => { throw new Error('Stale delivery never reached requester'); })]);
      await runScheduledTask(deps, { owner: account, taskId: id, deliveryId: 'final-run' });
      if (state === 'elapsed') vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01T00:00:01.000Z'));
      else await tasks.update(account, id, { endDate: '2000-01-01T00:00:00.000Z' });
      if (state === 'retired') await tasks.delete(account, id);
      release();
      await stale;
      expect(post.mock.calls.map(([event]) => event)).toEqual([
        expect.objectContaining({ content: 'Scheduled task "US rates": Rates update.' }),
        expect.objectContaining({ content: state === 'elapsed' ? 'Scheduled task "US rates": Rates update.' : state === 'expired'
          ? 'Scheduled task "US rates" skipped: the task was outside its active time window'
          : 'Scheduled task "US rates" skipped: the task was no longer available' }),
      ]);
      expect(invoke).toHaveBeenCalledTimes(state === 'elapsed' ? 2 : 1);
      const session = await stack.sessionMetadata.get(account, id);
      expect(session).toMatchObject({ scheduled_task_id: id });
      expect(session).not.toHaveProperty('turn_running_since');
      expect(session).not.toHaveProperty('turn_run_id');
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
      release(); await stale.catch(() => undefined);
    }
  });

  it.each([['before Starts', { startDate: '2099-01-01T00:00:00.000Z' }], ['after Ends', { endDate: '2000-01-01T00:00:00.000Z' }]] as const)('runs nothing %s while task metadata is still present (#3968)', async (_, bounds) => {
    const account = owner();
    const task = { id: 'spent', proposalId: 'spent-proposal', title: 'US rates', prompt: 'US rates', schedule: 'rate(1 minute)', timezone: 'UTC', paused: false, ended: true, ...bounds };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, browserEventName: 'test:browser', routes: new Hono(),
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
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
    const retire = vi.fn(async () => undefined);

    await runScheduledTask({
      runtimeNamespaceRequired: false, turnIdentity: null,
      summarizeTurn: async () => ({ title: 'US rates', summary: 'Gave a rates update.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun: async () => undefined, retire },
      upstream: sessionLifecycle({ label: 'AgentCore', invoke }, async () => undefined),
      invokeSessionApi: post,
    }, { owner: account, taskId: task.id, deliveryId: 'after-the-last-run' });

    expect(invoke).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  it('retires a one-off under the claiming account when Account Claim moves it mid-run', async () => {
    const claimed = await startInProcess({ scheduled: true });
    const source = owner();
    const destination = owner();
    const originalMain = await claimed.sessionMetadata.mainChat(source, `filed-${source}`);
    let sideChat: string | undefined;
    const recordTurn = claimed.sessionMetadata.recordTurn.bind(claimed.sessionMetadata);
    const beginDispatch = claimed.sessionMetadata.beginDispatch.bind(claimed.sessionMetadata);
    const recording = vi.spyOn(claimed.sessionMetadata, 'recordTurn').mockImplementation(async (account, sessionId, turn) => {
      const filingId = await recordTurn(account, sessionId, turn);
      if (account === source && turn.running !== undefined) sideChat = sessionId;
      return filingId;
    });
    // The Claim lands while the one-off's run is under way.
    const dispatching = vi.spyOn(claimed.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      const complete = await beginDispatch(...args);
      if (args[0] === source && args[1] === sideChat) await claimed.history.transfer(source, destination);
      return complete;
    });
    try {
      const prompt = 'Preview payrolls before the Claim';
      claimed.agentcore.scriptPrompt(prompt, stream(...text('claimed-once', 'Payrolls beat.')));
      const response = await claimed.app.request('/scheduled-tasks', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': source },
        body: JSON.stringify({ title: 'Payrolls', prompt, schedule: 'at(2026-10-02T13:30:00)', timezone: 'UTC', proposalId: prompt }),
      });
      const { id } = (await response.json()) as { id: string };
      await defined(claimed.scheduler, 'the Claim stack schedules tasks').fire(id);

      await vi.waitFor(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({ operation: 'post', sessionId: originalMain })));
      const listed = async () => ((await (await claimed.app.request('/scheduled-tasks', { headers: { 'x-test-owner': destination } })).json()) as { tasks: { id: string }[] }).tasks;
      await vi.waitFor(async () => expect(await listed()).toEqual([]));
    } finally {
      recording.mockRestore();
      dispatching.mockRestore();
      await claimed.stop();
    }
  });

  it('dispatches an accepted scheduled Turn after Account Claim moves its Session and task', async () => {
    const claimed = await startInProcess({ scheduled: true });
    const source = owner();
    const destination = owner();
    const originalMain = await claimed.sessionMetadata.mainChat(source, `filed-${source}`);
    let sideChat: string | undefined;
    let admitted: ((error: unknown) => void) | undefined;
    const admission = new Promise<unknown>((resolve) => { admitted = resolve; });
    const recordTurn = claimed.sessionMetadata.recordTurn.bind(claimed.sessionMetadata);
    const beginDispatch = claimed.sessionMetadata.beginDispatch.bind(claimed.sessionMetadata);
    const recording = vi.spyOn(claimed.sessionMetadata, 'recordTurn').mockImplementation(async (account, sessionId, turn) => {
      const filingId = await recordTurn(account, sessionId, turn);
      if (account === source && turn.running !== undefined) {
        sideChat = sessionId;
      }
      return filingId;
    });
    const dispatching = vi.spyOn(claimed.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      try {
        const complete = await beginDispatch(...args);
        if (args[0] === source && args[1] === sideChat) {
          await claimed.history.transfer(source, destination);
          defined(admitted, 'admission result')(undefined);
        }
        return complete;
      } catch (error) {
        if (args[0] === source && args[1] === sideChat) defined(admitted, 'admission result')(error);
        throw error;
      }
    });
    try {
      const prompt = 'Complete the accepted occurrence';
      claimed.agentcore.scriptPrompt(prompt, stream(...text('claimed-answer', 'Accepted occurrence completed.')));
      const response = await claimed.app.request('/scheduled-tasks', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': source },
        body: JSON.stringify({ title: 'Claimed brief', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt }),
      });
      const { id } = (await response.json()) as { id: string };
      await defined(claimed.scheduler, 'the Claim stack schedules tasks').fire(id);
      expect(await admission).toBeUndefined();
      const sessionId = defined(sideChat, 'accepted scheduled Side Chat');
      await vi.waitFor(() => expect(claimed.agentcore.invocationFor(sessionId).payload.forwardedProps.sessionUserId).toBe(`filed-${source}`));
      expect(await claimed.sessionMetadata.get(source, sessionId)).toBeNull();
      expect(await claimed.sessionMetadata.get(destination, sessionId)).toEqual(expect.objectContaining({ filing_user_id: `filed-${source}` }));
      const tasks = (await (await claimed.app.request('/scheduled-tasks', { headers: { 'x-test-owner': destination } })).json()) as { tasks: { id: string }[] };
      expect(tasks.tasks).toContainEqual(expect.objectContaining({ id }));
      await vi.waitFor(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({
        operation: 'post', sessionId: originalMain, userId: `filed-${source}`, content: 'Scheduled task "Claimed brief": Accepted occurrence completed.',
      })));
    } finally {
      recording.mockRestore();
      dispatching.mockRestore();
      await claimed.stop();
    }
  });

  it.each(['accepted', 'destination deleted', 'replaced post', 'Claim starts during admission'] as const)('preserves the accepted Main Chat post through Account Claim: %s', async (outcome) => {
    const claimed = await startInProcess({ scheduled: true });
    const source = owner();
    const destination = owner();
    const main = ((await (await claimed.app.request('/main-chat', { headers: { 'x-test-owner': source } })).json()) as { id: string }).id;
    let admitted: ((error: unknown) => void) | undefined;
    const admission = new Promise<unknown>((resolve) => { admitted = resolve; });
    let mainAccepted = false;
    let claimStarted = false;
    claimed.table.client.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { Key?: { pk?: string | { S?: string }; sk?: string | { S?: string } } };
      const pk = typeof input.Key?.pk === 'string' ? input.Key.pk : input.Key?.pk?.S;
      const sk = typeof input.Key?.sk === 'string' ? input.Key.sk : input.Key?.sk?.S;
      const result = await next(args);
      if (outcome === 'Claim starts during admission' && mainAccepted && !claimStarted && context.commandName === 'GetItemCommand' && pk === `SESSIONS#${source}` && sk === 'CLAIM') {
        claimStarted = true;
        await claimed.history.transfer(source, destination);
      }
      return result;
    }, { step: 'initialize', name: 'moveAfterAbsentClaimRead' });
    const recordTurn = claimed.sessionMetadata.recordTurn.bind(claimed.sessionMetadata);
    const beginDispatch = claimed.sessionMetadata.beginDispatch.bind(claimed.sessionMetadata);
    const dispatching = vi.spyOn(claimed.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      try {
        if (args[0] === source && args[1] === main) {
          mainAccepted = true;
          if (outcome !== 'Claim starts during admission') await claimed.history.transfer(source, destination);
          if (outcome === 'destination deleted') await claimed.sessionMetadata.fenceOwner(destination);
          if (outcome === 'replaced post') await recordTurn(destination, main, { filingUserId: `filed-${destination}`, title: 'Newer post', messageId: 'replacement-message' });
        }
        const complete = await beginDispatch(...args);
        if (args[0] === source && args[1] === main) defined(admitted, 'Main Chat admission')(undefined);
        return complete;
      } catch (error) {
        if (args[0] === source && args[1] === main) defined(admitted, 'Main Chat admission')(error);
        throw error;
      }
    });
    try {
      const prompt = 'Produce the accepted Main Chat result';
      claimed.agentcore.scriptPrompt(prompt, stream(...text('main-answer', 'Preserved result.')));
      const response = await claimed.app.request('/scheduled-tasks', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': source },
        body: JSON.stringify({ title: 'Moved result', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt }),
      });
      const { id } = (await response.json()) as { id: string };
      const runs = defined(claimed.scheduler, 'the Claim stack schedules tasks');
      await runs.fire(id);
      if (outcome === 'accepted' || outcome === 'Claim starts during admission') {
        expect(await admission).toBeUndefined();
        await vi.waitFor(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({
          operation: 'post', sessionId: main, userId: `filed-${source}`, content: 'Scheduled task "Moved result": Preserved result.',
        })));
        await vi.waitFor(async () => expect(await runs.queued()).toBe(0));
        expect(await claimed.sessionMetadata.get(source, main)).toBeNull();
        expect(await claimed.sessionMetadata.get(destination, main)).toEqual(expect.objectContaining({ filing_user_id: `filed-${source}` }));
        expect(await claimed.sessionMetadata.get(destination, main)).not.toHaveProperty('turn_running_since');
        expect(await claimed.sessionMetadata.get(destination, main)).not.toHaveProperty('turn_preparing');
      } else {
        expect(await admission).toBeInstanceOf(SessionDeletedError);
        expect(claimed.sessionApi.events().filter((event) => event.operation === 'post' && event.sessionId === main)).toEqual([]);
      }
    } finally {
      dispatching.mockRestore();
      await claimed.stop();
    }
  });

  it.each(['accepted', 'destination deleted', 'moves during admission'] as const)('preserves the accepted Main Chat post while Account Claim is still moving: %s', async (outcome) => {
    const claimed = await startInProcess({ scheduled: true });
    const source = owner();
    const destination = owner();
    const main = ((await (await claimed.app.request('/main-chat', { headers: { 'x-test-owner': source } })).json()) as { id: string }).id;
    let admitted: ((error: unknown) => void) | undefined;
    const admission = new Promise<unknown>((resolve) => { admitted = resolve; });
    let claimEntered: (() => void) | undefined;
    let releaseClaim: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { claimEntered = resolve; });
    const held = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let transfer: Promise<void> | undefined;
    let claimStored = false;
    let movedDuringAdmission = false;
    claimed.table.client.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { Item?: { pk?: string | { S?: string }; sk?: string | { S?: string } }; Key?: { pk?: string | { S?: string }; sk?: string | { S?: string } } };
      const row = input.Item ?? input.Key;
      const pk = typeof row?.pk === 'string' ? row.pk : row?.pk?.S;
      const sk = typeof row?.sk === 'string' ? row.sk : row?.sk?.S;
      const result = await next(args);
      if (context.commandName === 'PutItemCommand' && pk === `SESSIONS#${source}` && sk === 'CLAIM') {
        claimStored = true;
        defined(claimEntered, 'durable Claim fence')();
        await held;
      }
      if (outcome === 'moves during admission' && claimStored && !movedDuringAdmission && context.commandName === 'GetItemCommand' && pk === `SESSIONS#${destination}` && sk === `SESSION#${main}`) {
        movedDuringAdmission = true;
        defined(releaseClaim, 'move between identity reads')();
        await transfer;
      }
      return result;
    }, { step: 'initialize', name: 'holdClaimAfterMainPostAcceptance' });
    const beginDispatch = claimed.sessionMetadata.beginDispatch.bind(claimed.sessionMetadata);
    const dispatching = vi.spyOn(claimed.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      try {
        if (args[0] === source && args[1] === main) {
          transfer = claimed.history.transfer(source, destination);
          await entered;
          if (outcome === 'destination deleted') await claimed.sessionMetadata.fenceOwner(destination);
        }
        const complete = await beginDispatch(...args);
        if (args[0] === source && args[1] === main) defined(admitted, 'Main Chat admission')(undefined);
        return complete;
      } catch (error) {
        if (args[0] === source && args[1] === main) defined(admitted, 'Main Chat admission')(error);
        throw error;
      }
    });
    try {
      const prompt = 'Produce the accepted Main Chat result';
      claimed.agentcore.scriptPrompt(prompt, stream(...text('main-answer', 'Preserved result.')));
      const response = await claimed.app.request('/scheduled-tasks', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': source },
        body: JSON.stringify({ title: 'Moved result', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt }),
      });
      const { id } = (await response.json()) as { id: string };
      const runs = defined(claimed.scheduler, 'the Claim stack schedules tasks');
      await runs.fire(id);
      if (outcome !== 'destination deleted') {
        expect(await admission).toBeUndefined();
        await vi.waitFor(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({
          operation: 'post', sessionId: main, userId: `filed-${source}`, content: 'Scheduled task "Moved result": Preserved result.',
        })));
        await vi.waitFor(async () => expect(await runs.queued()).toBe(0));
        defined(releaseClaim, 'finish Claim')();
        await transfer;
        expect(await claimed.sessionMetadata.get(source, main)).toBeNull();
        expect(await claimed.sessionMetadata.get(destination, main)).toEqual(expect.objectContaining({ filing_user_id: `filed-${source}` }));
        expect(await claimed.sessionMetadata.get(destination, main)).not.toHaveProperty('turn_running_since');
        expect(await claimed.sessionMetadata.get(destination, main)).not.toHaveProperty('turn_preparing');
      } else {
        expect(await admission).toBeInstanceOf(SessionDeletedError);
        expect(claimed.sessionApi.events().filter((event) => event.operation === 'post' && event.sessionId === main)).toEqual([]);
      }
    } finally {
      defined(releaseClaim, 'release paused Claim')();
      await transfer;
      dispatching.mockRestore();
      await claimed.stop();
    }
  });

  it.each(['finished', 'failed'])('omits the marker while a scheduled Turn prepares, then names it once %s', async (outcome) => {
    const account = owner();
    const main = await mainChat(account);
    let release!: () => void;
    let entered!: (sessionId: string) => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const recorded = new Promise<string>((resolve) => { entered = resolve; });
    const recordTurn = stack.sessionMetadata.recordTurn.bind(stack.sessionMetadata);
    const paused = vi.spyOn(stack.sessionMetadata, 'recordTurn').mockImplementation(async (owner, sessionId, turn) => {
      const userId = await recordTurn(owner, sessionId, turn);
      if (owner === account && sessionId !== main) {
        entered(sessionId);
        await held;
      }
      return userId;
    });
    try {
      await run(account, outcome === 'finished' ? stream(...text('answer', 'Done.')) : stream({ type: 'RUN_ERROR', message: 'Failed' }));
      const sideChat = await recorded;
      stack.sessionApi.reply(sideChat, 200, { messages: [] });
      await request(account, `/threads/${sideChat}`);
      expect(stack.sessionApi.events()).toContainEqual({ operation: 'get', sessionId: sideChat, userId: `filed-${account}` });
      release();
      await posted(main);
      expect(await stack.sessionMetadata.get(account, sideChat)).not.toHaveProperty('turn_running_since');
    } finally {
      release();
      paused.mockRestore();
    }
  });

  it('does not publish an unfinished stream as a completed scheduled answer', async () => {
    const account = owner();
    const main = await mainChat(account);
    const partial = {
      kind: 'stream' as const,
      frames: [{ type: 'RUN_STARTED' }, ...text('partial', 'Unfinished research conclusion')].map((frame) => `data: ${JSON.stringify(frame)}`),
    };
    await run(account, partial);
    const posts = await posted(main);
    expect(posts).toEqual([{ content: 'Scheduled task "Morning brief" failed: AgentCore upstream stream ended before RUN_FINISHED', userId: `filed-${account}` }]);
    expect(stack.bedrock.summarizedTurns()).not.toContainEqual(expect.objectContaining({ answer: 'Unfinished research conclusion' }));

    await run(account, stream(...text('recovered', 'Completed research conclusion')), 'Recovered brief');
    await vi.waitFor(async () => expect(await posted(main)).toContainEqual({ content: 'Scheduled task "Recovered brief": Completed research conclusion', userId: `filed-${account}` }), { timeout: 2_000 });
  });

  it.each([
    { name: 'run error', frames: [{ type: 'RUN_ERROR', message: 'Model overloaded' }], expected: 'failed: Model overloaded' },
    { name: 'multipart sign-in request', frames: [{ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: [{ type: 'text', text: 'Sign in to ' }, { type: 'text', text: 'continue.' }] }], expected: 'could not finish: Sign in to continue.' },
    { name: 'sign-in request', frames: [{ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: 'Sign in to continue.' }], expected: 'could not finish: Sign in to continue.' },
  ])('preserves an unfinished stream’s $name before the missing completion error', async ({ frames, expected }) => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, { kind: 'stream', frames: [{ type: 'RUN_STARTED' }, ...frames].map((frame) => `data: ${JSON.stringify(frame)}`) });
    expect((await posted(main)).map(({ content }) => content)).toEqual([`Scheduled task "Morning brief" ${expected}`]);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0), { timeout: 2_000 });
  });

  it.each([
    { status: 'done', frames: [...text('a1', 'The 10y yield fell 5bp.')], text: 'The 10y yield fell 5bp.' },
    { status: 'failed', frames: [{ type: 'RUN_ERROR', message: 'Model overloaded' }], text: 'Model overloaded' },
    { status: 'sign-in', frames: [{ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: 'Sign in to continue.' }], text: 'Sign in to continue.' },
  ])('posts a $status run with its run card, which opens the task Side Chat at the run', async ({ status, frames, text: excerpt }) => {
    const account = owner();
    const main = await mainChat(account);
    const before = new Date().toISOString();

    const { id, prompt } = await run(account, stream(...frames), 'Rates brief');

    await posted(main);
    const post = defined(stack.sessionApi.events().find((event) => event.operation === 'post' && event.sessionId === main), 'the post');
    const invocation = JSON.parse(defined(stack.agentcore.invocations().find(({ body }) => body.includes(prompt)), 'the run').body) as { messages: { id: string }[] };
    expect('scheduledRun' in post && post.scheduledRun).toEqual({
      sideChat: id,
      messageId: defined(invocation.messages[0], 'the run request').id,
      title: 'Rates brief',
      ranAt: expect.any(String),
      status,
      text: excerpt,
    });
    expect(defined('scheduledRun' in post ? post.scheduledRun : undefined, 'the run card').ranAt >= before).toBe(true);
  });

  // A card opens the run in its Side Chat: a run that never got there has nothing to open. Its own stack, since the
  // failed delivery stays on the queue and backs the poller off, which would hold up a later run.
  it('posts a run that failed before reaching its Side Chat with a run card that has nothing to open', async () => {
    const isolated = await startInProcess({ scheduled: true, cartridge: {
      scheduledRequester: async (owner) => ({ owner, scheduled: true }),
      accountModels: async (requester) => {
        if ('scheduled' in requester) throw new Error('The plan catalog is unavailable');
        return [{ key: 'plan', label: 'Plan', provider: 'openai' }];
      },
    } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const account = owner();
      const call = (path: string, body?: unknown) => isolated.app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': account },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const { id: main } = await (await call('/main-chat')).json() as { id: string };
      const { id } = await (await call('/scheduled-tasks', {
        title: 'Rates brief', prompt: 'Brief me on rates.', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'unavailable-catalog',
      })).json() as { id: string };
      await defined(isolated.scheduler, 'the isolated schedule').fire(id);

      await posted(main, isolated.sessionApi);
      const post = defined(isolated.sessionApi.events().find((event) => event.operation === 'post' && event.sessionId === main), 'the post');
      expect('scheduledRun' in post && post.scheduledRun).toEqual({
        title: 'Rates brief', ranAt: expect.any(String), status: 'failed', text: 'The plan catalog is unavailable',
      });
      expect(await (await call('/threads')).json()).toEqual({ threads: [] });
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.objectContaining({ message: 'The plan catalog is unavailable' })));
      // Its task has a Last run, but no Side Chat for its sheet to open.
      const { tasks } = (await (await call('/scheduled-tasks')).json()) as { tasks: object[] };
      expect(tasks).toEqual([expect.objectContaining({ lastRun: { at: expect.any(String), status: 'failed' }, sideChat: false })]);
    } finally {
      await isolated.stop();
      errors.mockRestore();
    }
  });

  it("runs the prompt as the first Turn of the task Side Chat and posts the agent's last answer to the Main Chat", async () => {
    const account = owner();
    const main = await mainChat(account);
    const started = Date.now();

    const { prompt } = await run(
      account,
      stream(
        ...text('a1', 'Checking ', 'the curve.'),
        ': a comment line',
        ...text('a2', '  The 10y yield ', 'fell 5bp overnight.  '),
        ...text('a3', '   '),
      ),
    );

    const posts = await posted(main);
    expect(posts).toEqual([
      { content: 'Scheduled task "Morning brief": The 10y yield fell 5bp overnight.', userId: `filed-${account}` },
    ]);
    stack.sessionApi.reply(main, 200, { messages: [] });
    await request(account, '/main-chat');
    expect(stack.sessionApi.events()).toContainEqual({
      operation: 'get',
      sessionId: main,
      userId: `filed-${account}`,
    });
    const threads = ((await (await request(account, '/threads')).json()) as { threads: { id: string; title: string }[] }).threads;
    expect(threads).toEqual([expect.objectContaining({ title: 'Morning brief' })]);
    const sideChat = defined(threads[0], 'the run Side Chat').id;
    expect(sideChat).not.toBe(main);
    const { payload } = stack.agentcore.invocationFor(sideChat);
    expect(payload).toMatchObject({
      threadId: sideChat,
      messages: [{ role: 'user', content: prompt }],
      forwardedProps: {
        requester: { owner: account, scheduled: true },
        // The owner's default model, the one the composer starts on.
        model: 'plan',
        approvedModel: { key: 'plan', label: 'Plan', provider: 'openai' },
        sessionUserId: `filed-${account}`,
        agentIdentity: { name: 'Test Bot' },
        soul: 'Be brief.',
        // The Harness leaves out the proposal tool, so a run never proposes another task (#3950).
        scheduledRun: true,
      },
    });
    expect(signInChecks).toContainEqual({ owner: account, outputs: ['Checking the curve.', 'The 10y yield fell 5bp overnight.'] });
    expect(await activity(account, started)).toEqual([{ title: 'Answered a question', summary: 'Replied to the user' }]);
    expect(stack.bedrock.summarizedTurns()).toContainEqual({
      request: prompt,
      answer: 'The 10y yield fell 5bp overnight.',
    });
    // The run is done, so it leaves the queue.
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0), { timeout: 2_000 });
  });

  it("runs on the owner's default model, the one the composer starts on, when the task names none", async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, stream(...text('a1', 'Done.')));

    await posted(main);
    const [sideChat] = ((await (await request(account, '/threads')).json()) as { threads: { id: string }[] }).threads;
    expect(stack.agentcore.invocationFor(defined(sideChat, 'the run Side Chat').id).payload.forwardedProps).toMatchObject({
      model: 'plan',
      approvedModel: { key: 'plan', label: 'Plan', provider: 'openai' },
    });
  });

  it('runs on the proposing model confirmed at creation', async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, stream(...text('a1', 'Done.')), 'Morning brief', { model: 'thorough' });

    await posted(main);
    const [sideChat] = ((await (await request(account, '/threads')).json()) as { threads: { id: string }[] }).threads;
    expect(stack.agentcore.invocationFor(defined(sideChat, 'the run Side Chat').id).payload.forwardedProps).toMatchObject({
      model: 'thorough',
      approvedModel: { key: 'thorough', label: 'Thorough', description: 'Slower, more careful', provider: 'anthropic' },
    });
  });

  it.each(['thorough', 'plan'])("runs on the model %s the task names without the account's plan catalog", async (model) => {
    const account = owner();
    const main = await mainChat(account);
    unavailableCatalogs.add(account);

    await run(account, stream(...text('a1', 'Done.')), 'Morning brief', { model });

    expect(await posted(main)).toEqual([{ content: 'Scheduled task "Morning brief": Done.', userId: `filed-${account}` }]);
  });

  it("keeps its Side Chat on the default model's provider, and the Main Chat on none until the user's Turn", async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, stream(...text('a1', 'Done.')));

    await posted(main);
    const [sideChat] = ((await (await request(account, '/threads')).json()) as { threads: { id: string }[] }).threads;
    expect(await (await request(account, `/threads/${defined(sideChat, 'the run Side Chat').id}`)).json()).toMatchObject({
      provider: 'openai',
    });
    expect(await (await request(account, '/main-chat')).json()).not.toHaveProperty('provider');
  });

  it.each([
    ['same ID safe history', 'safe-', 'a1', ['safe-token']],
    ['different ID credential prefix', 'scheduled-invocation-', 'a2', ['scheduled-invocation-', 'token']],
  ])('preserves scheduled aggregation for %s across a snapshot', async (_, prefix, secondId, outputs) => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(...text('a1', prefix), { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'a1', role: 'assistant', content: 'safe replacement' }] }, ...text(secondId, 'token')));
    expect((await posted(main)).map(({ content }) => content)).toEqual([`Scheduled task "Morning brief": ${outputs.at(-1)}`]);
    expect(signInChecks).toContainEqual({ owner: account, outputs });
  });

  it.each([
    {
      name: 'a run error',
      frames: [...text('a1', 'Partial'), { type: 'RUN_ERROR', message: 'Model overloaded' }],
      post: 'Scheduled task "Morning brief" failed: Model overloaded',
      listed: { failed: 'Model overloaded' },
    },
    {
      name: 'a sign-in needed without a run error',
      frames: [
        { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: 'Sign in to continue.' },
        ...text('a1', 'I need you to sign in.'),
      ],
      post: 'Scheduled task "Morning brief" could not finish: Sign in to continue.',
      listed: {},
    },
  ])('leaves $name out of the finished-Turn Activity summaries', async ({ frames, post, listed }) => {
    const account = owner();
    const main = await mainChat(account);
    const started = Date.now();
    const { prompt } = await run(account, stream(...frames));
    expect((await posted(main)).map(({ content }) => content)).toEqual([post]);

    expect(await activity(account, started)).toEqual([{ summary: prompt, ...listed }]);
  });

  it('says so when the agent finished without an answer', async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, stream());

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Morning brief": finished without an answer.']);
  });

  it('posts the answer from a multiline SSE data field', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream('data: {"type":"TEXT_MESSAGE_CONTENT",\ndata: "messageId":"m1","delta":"safe answer"}'));

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Morning brief": safe answer']);
  });

  it("posts the run's error", async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, stream(...text('a1', 'Partial'), { type: 'RUN_ERROR', message: 'Model overloaded' }));

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Morning brief" failed: Model overloaded']);
  });

  it.each([
    ['Files access key in malformed data', [`data: ${turnSecrets.files.accessKeyId}`]],
    ['Files access key in text', text('a1', turnSecrets.files.accessKeyId)],
    ['Files session token in a tool result', [{ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: `Sign in to continue: ${turnSecrets.files.sessionToken}` }]],
    ['CDP URL in a run error', [{ type: 'RUN_ERROR', message: `Failed: ${turnSecrets.agentComputerCdpUrl}` }]],
    ['CDP bearer token on its own', text('a1', 'scheduled-cdp-token')],
    ['invocation token split across text deltas', text('a1', 'scheduled-invocation-', 'token')],
    ['Files secret split across tool argument deltas', [
      { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'execute' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"scheduled/' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: 'secret+key"}' },
      { type: 'TOOL_CALL_END', toolCallId: 't1' },
    ]],
    ['JSON-escaped Files secret in a run error', ['data: {"type":"RUN_ERROR","message":"scheduled\\/secret+key"}']],
    ['Files secret in a state snapshot', [{ type: 'STATE_SNAPSHOT', snapshot: { files: { secretAccessKey: turnSecrets.files.secretAccessKey } } }]],
    ['credential used as an escaped state property name', ['data: {"type":"STATE_SNAPSHOT","snapshot":{"scheduled-\\u0073ession-token":true}}']],
    ['an escaped credential in a multiline state event', ['data: {"type":"STATE_SNAPSHOT","snapshot":{"token":\ndata: "scheduled-\\u0073ession-token"}}']],
    ...([['literal', 'scheduled-invocation-', 'token'], ['encoded query token', 'scheduled%2', 'Dcdp-token']] as const).map(([label, first, last]): [string, Record<string, unknown>[]] => [
      `${label} assembled by scheduled output after safe snapshot replacement`, [
        ...text('a1', first), { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'a1', role: 'assistant', content: 'safe replacement' }] }, ...text('a1', last),
      ],
    ]),
    ['adjacent multipart text credential', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'scheduled-invocation-' }, { type: 'text', text: 'token' }] }] }]],
    ['JSON Pointer decoded Files secret property', [{ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/scheduled~1secret+key', value: true }] }]],
    ['run input seeded text', [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r', input: { threadId: 't', runId: 'r', state: {}, messages: [{ id: 'a1', role: 'assistant', content: 'scheduled-invocation-' }], tools: [], context: [], forwardedProps: {} } },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
    ]],
    ['tool result seeded text', [
      { type: 'TOOL_CALL_RESULT', messageId: 'a1', toolCallId: 't1', content: 'scheduled-invocation-' },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
    ]],
    ['activity root-patch seeded text', [
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'a1', activityType: 'test', content: {} },
      { type: 'ACTIVITY_DELTA', messageId: 'a1', activityType: 'test', patch: [{ op: 'replace', path: '', value: 'scheduled-invocation-' }] },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
    ]],
    ...['TEXT_MESSAGE', 'REASONING_MESSAGE', 'TOOL_CALL'].flatMap((kind): [string, Record<string, unknown>[]][] => {
      const identity = kind === 'TOOL_CALL' ? { toolCallId: 'x', toolCallName: 'execute' } : { messageId: 'x' };
      const content = kind === 'TOOL_CALL' ? 'TOOL_CALL_ARGS' : `${kind}_CONTENT`;
      return [['literal', 'scheduled-invocation-', 'token'], ['encoded', 'scheduled%2', 'Dcdp-token']].map(([label, first, last]) => [
        `${label} token across reused ${kind} ID`, [
          { type: `${kind}_START`, ...identity }, { type: content, ...identity, delta: first },
          { type: `${kind}_END`, ...identity }, { type: `${kind}_START`, ...identity },
          { type: content, ...identity, delta: last }, { type: `${kind}_END`, ...identity },
        ],
      ]);
    }),
    ...['TEXT_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK', 'REASONING_MESSAGE_CHUNK'].flatMap((type): [string, Record<string, unknown>[]][] => [
      [`literal token split across ${type}`, [
        { type, ...(type === 'TOOL_CALL_CHUNK' ? { toolCallId: 't1', toolCallName: 'execute' } : { messageId: 'a1' }), delta: 'scheduled-invocation-' },
        { type: 'RAW', event: {} },
        { type, delta: 'token' },
      ]],
      [`encoded token split across ${type}`, [
        { type, ...(type === 'TOOL_CALL_CHUNK' ? { toolCallId: 't1', toolCallName: 'execute' } : { messageId: 'a1' }), delta: 'scheduled%2' },
        { type, delta: 'Dcdp-token' },
      ]],
    ]),
    ['invocation token split across reasoning deltas', [
      { type: 'REASONING_MESSAGE_START', messageId: 'a1' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'scheduled-invocation-' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
      { type: 'REASONING_MESSAGE_END', messageId: 'a1' },
    ]],
    ['encoded CDP query token split across reasoning deltas', [
      { type: 'REASONING_MESSAGE_START', messageId: 'a1' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'scheduled%2' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'Dcdp-token' },
      { type: 'REASONING_MESSAGE_END', messageId: 'a1' },
    ]],
    ['encoded standalone CDP token in text', text('a1', 'scheduled%2Dcdp-token')],
    ['encoded standalone CDP token in tool arguments', [{ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"token":"scheduled%2Dcdp-token"}' }]],
    ['encoded standalone CDP token split across text', text('a1', 'scheduled%2', 'Dcdp-token')],
    ['percent-encoded CDP URL in text', text('a1', 'open https://computer.example/cdp?token=%73cheduled-cdp-token')],
    ['percent-encoded CDP URL split across text deltas', text('a1', 'open https://computer.example/cdp?token=%73cheduled-', 'cdp-token')],
    ['percent-encoded CDP URL in tool arguments', [{ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"open https://computer.example/cdp?token=%73cheduled-cdp-token"}' }]],
  ])('withholds %s before sign-in checks or a Main Chat post', async (_, frames) => {
    const account = owner();
    const main = await mainChat(account);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await run(account, stream(...frames));

      expect((await posted(main)).map(({ content }) => content)).toEqual([
        'Scheduled task "Morning brief" failed: The agent\'s answer carried the Turn\'s credentials, so it was withheld',
      ]);
      expect(signInChecks.filter((check) => check.owner === account).flatMap((check) => check.outputs)).toEqual([]);
      const logged = errors.mock.calls.flat().map(String).join('\n');
      for (const secret of [...Object.values(turnSecrets.files), turnSecrets.credentialServiceInvocationToken, turnSecrets.agentComputerCdpUrl]) {
        expect(logged).not.toContain(secret);
      }
      await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0), { timeout: 2_000 });
    } finally {
      errors.mockRestore();
    }
  });

  it.each([
    turnSecrets.files.sessionToken,
    'failed token scheduled%2Dcdp-token',
    '{"message":"scheduled\\/secret+key"}',
    '{"scheduled-\\u0073ession-token":"diagnostic"}',
    'failed to open https://computer.example/cdp?token=%73cheduled-cdp-token',
  ])('withholds a credential-bearing HTTP refusal before a Main Chat post: %s', async (body) => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, { kind: 'error', status: 503, body });

    expect((await posted(main)).map(({ content }) => content)).toEqual([
      'Scheduled task "Morning brief" failed: AgentCore upstream returned HTTP 503: The error body carried the Turn\'s credentials, so it was withheld',
    ]);
    expect(signInChecks.filter((check) => check.owner === account).flatMap((check) => check.outputs)).toEqual([]);
  });

  it("posts the upstream's refusal", async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, { kind: 'error', status: 502, body: '  Runtime unavailable\n' });

    expect((await posted(main)).map(({ content }) => content)).toEqual([
      'Scheduled task "Morning brief" failed: AgentCore upstream returned HTTP 502: Runtime unavailable',
    ]);
    expect(signInChecks).toContainEqual({ owner: account, outputs: [] });
  });

  it('says the run could not finish when it needed the user to sign in, before any error', async () => {
    const account = owner();
    const main = await mainChat(account);

    await run(
      account,
      stream(
        { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: 'Sign in to continue.' },
        ...text('a1', 'I need you to sign in.'),
        { type: 'RUN_ERROR', message: 'Stopped' },
      ),
      'Credit brief',
    );

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Credit brief" could not finish: Sign in to continue.']);
    expect(signInChecks).toContainEqual({ owner: account, outputs: ['Sign in to continue.', 'I need you to sign in.'] });
  });

  it.each([
    ['done', stream(...text('a1', 'All quiet.'))],
    ['failed', stream({ type: 'RUN_ERROR', message: 'Model overloaded' })],
    ['sign-in', stream({ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: 'Sign in to continue.' })],
  ])("lists the run as its task's last run, %s", async (status, script) => {
    const account = owner();
    const main = await mainChat(account);
    const started = Date.now();

    const { id } = await run(account, script);

    // The run records its end once its Main Chat post is in.
    await posted(main);
    await vi.waitFor(async () => {
      const { tasks } = (await (await request(account, '/scheduled-tasks')).json()) as { tasks: { id: string; lastRun?: { at: string; status: string } }[] };
      const lastRun = defined(tasks.find((task) => task.id === id)?.lastRun, 'the last run');
      expect(lastRun.status).toBe(status);
      expect(Date.parse(lastRun.at)).toBeGreaterThanOrEqual(started);
    }, { timeout: 3_000 });
  });

  it('marks the task Side Chat as scheduled in the Side Chat list, and no other', async () => {
    const account = owner();
    await stack.sessionMetadata.recordTurn(account, 'topic-chat', { filingUserId: `filed-${account}`, title: 'My topic' });

    const { id } = await run(account, stream(...text('a1', 'All quiet.')));

    await vi.waitFor(async () => {
      const { threads } = (await (await request(account, '/threads')).json()) as { threads: { id: string; scheduled?: boolean }[] };
      expect(threads.map(({ id: thread, scheduled }) => [thread, scheduled])).toEqual(expect.arrayContaining([[id, true], ['topic-chat', undefined]]));
    }, { timeout: 3_000 });
  });

  it('does not invoke a paused task when its schedule delivers a run', async () => {
    const account = owner();
    const main = await mainChat(account);
    const prompt = `Paused brief ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('a1', 'Resumed execution')));
    const created = await request(account, '/scheduled-tasks', {
      method: 'POST',
      body: { title: 'Paused brief', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt },
    });
    const { id } = (await created.json()) as { id: string };
    const delivery = defined(await scheduler.schedule(id), 'the schedule').Target.Input;
    expect((await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: true } })).status).toBe(200);
    expect(await scheduler.schedule(id)).toMatchObject({ State: 'DISABLED' });
    await scheduler.deliver(delivery);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0), { timeout: 2_000 });
    expect(stack.agentcore.invocations().map(({ body }) => body)).not.toContainEqual(expect.stringContaining(prompt));
    expect(stack.sessionApi.events().filter((event) => event.operation === 'post' && event.sessionId === main)).toEqual([]);
    expect(await (await request(account, '/threads')).json()).toEqual({ threads: [] });

    expect((await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: false } })).status).toBe(200);
    const sends = vi.spyOn(SQSClient.prototype, 'send');
    try {
      await scheduler.deliver(delivery);
      // The resumed model, summary and Main post precede SQS acknowledgement.
      // Observe that acknowledgement rather than imposing a queue-drain budget.
      for (;;) {
        const acknowledged = sends.mock.calls.findIndex(([command]) => command instanceof DeleteMessageCommand && command.input.QueueUrl === scheduler.runs.queueUrl);
        if (acknowledged !== -1) {
          // eslint-disable-next-line no-await-in-loop -- await the observed acknowledgement itself
          await defined(sends.mock.results[acknowledged], 'resumed delivery acknowledgement').value;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- wait for this queue's actual acknowledgement, bounded by the test timeout
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await scheduler.queued()).toBe(0);
    } finally { sends.mockRestore(); }
    expect(stack.agentcore.invocations().filter(({ body }) => body.includes(prompt))).toHaveLength(1);
    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Paused brief": Resumed execution']);
  });

  it('runs a task whose stored schedule its next run cannot be read from', async () => {
    const account = owner();
    const main = await mainChat(account);
    const prompt = `Unread ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('a1', 'Ran anyway')));
    const { id } = (await (await request(account, '/scheduled-tasks', {
      method: 'POST', body: { title: 'Unread', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt },
    })).json()) as { id: string };
    await DynamoDBDocumentClient.from(stack.table.client).send(new UpdateCommand({
      TableName: stack.table.name, Key: { pk: `SCHEDULED#${account}`, sk: `TASK#${id}` },
      UpdateExpression: 'SET schedule = :schedule', ExpressionAttributeValues: { ':schedule': 'cron(0 9 W * ? *)' },
    }));

    await scheduler.fire(id);

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Unread": Ran anyway']);
  });

  it('skips a run whose task was deleted after the schedule fired', async () => {
    const account = owner();
    const main = await mainChat(account);
    const prompt = 'A deleted brief';
    stack.agentcore.scriptPrompt(prompt, stream(...text('a1', 'Too late')));
    const { id } = (await (
      await request(account, '/scheduled-tasks', {
        method: 'POST',
        body: { title: 'Deleted', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'call-deleted' },
      })
    ).json()) as { id: string };
    const schedule = defined(await scheduler.schedule(id), 'the schedule');
    await request(account, `/scheduled-tasks/${id}`, { method: 'DELETE' });

    await scheduler.deliver(schedule.Target.Input);
    await run(account, stream(...text('a1', 'On time')), 'Kept');

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Kept": On time']);
    expect(stack.agentcore.invocations().map(({ body }) => body)).not.toContainEqual(expect.stringContaining(prompt));
  });

  it('records a scheduled Side Chat and clears its running Turn when its payload fails', async () => {
    const isolated = await startInProcess({ scheduled: true, cartridge: {
      invocationPayload: async () => { throw new Error('Computer capability is unavailable'); },
    } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const account = owner();
      const call = (path: string, body?: unknown) => isolated.app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': account },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const { id: main } = await (await call('/main-chat')).json() as { id: string };
      const { id } = await (await call('/scheduled-tasks', {
        title: 'Unavailable computer', prompt: 'Open the template site.', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'unavailable-computer',
      })).json() as { id: string };
      await defined(isolated.scheduler, 'the isolated schedule').fire(id);
      await posted(main, isolated.sessionApi);
      expect(isolated.sessionApi.events()).toContainEqual(expect.objectContaining({
        operation: 'post', sessionId: main, content: 'Scheduled task "Unavailable computer" failed: Computer capability is unavailable',
      }));
      const { threads } = await (await call('/threads')).json() as { threads: { id: string }[] };
      expect(threads).toHaveLength(1);
      const sideChat = defined(threads[0], 'the failed scheduled Side Chat').id;
      expect(await isolated.sessionMetadata.get(account, sideChat)).not.toHaveProperty('turn_running_since');
      expect(isolated.agentcore.invocations()).toEqual([]);
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.objectContaining({ message: 'Computer capability is unavailable' })));
    } finally {
      await isolated.stop();
      errors.mockRestore();
    }
  });

  // Scheduler deleted the one-off's schedule when it fired, so it can never run again: once the Main Chat has heard, it goes.
  it('retires a one-off task whose run failed once its failure reaches the Main Chat, still failing its delivery', async () => {
    const isolated = await startInProcess({ scheduled: true, cartridge: {
      invocationPayload: async () => { throw new Error('Computer capability is unavailable'); },
    } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const account = owner();
      const call = (path: string, body?: unknown) => isolated.app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': account },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const { id: main } = await (await call('/main-chat')).json() as { id: string };
      const { id } = await (await call('/scheduled-tasks', {
        title: 'Payrolls', prompt: 'Preview payrolls.', schedule: 'at(2026-10-02T13:30:00)', timezone: 'UTC', proposalId: 'failed-one-off',
      })).json() as { id: string };
      const queue = defined(isolated.scheduler, 'the isolated schedule');

      await queue.fire(id);

      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.objectContaining({ message: 'Computer capability is unavailable' })));
      expect((await posted(main, isolated.sessionApi)).map(({ content }) => content)).toEqual(['Scheduled task "Payrolls" failed: Computer capability is unavailable']);
      expect(await (await call('/scheduled-tasks')).json()).toEqual({ tasks: [] });
    } finally {
      await isolated.stop();
      errors.mockRestore();
    }
  });

  it('tells the Main Chat of a one-off paused after it fired, then retires it without running it', async () => {
    const account = owner();
    const main = await mainChat(account);
    const prompt = `Paused once ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('a1', 'Never ran')));
    const { id } = (await (await request(account, '/scheduled-tasks', {
      method: 'POST', body: { title: 'Payrolls', prompt, schedule: 'at(2026-10-02T13:30:00)', timezone: 'UTC', proposalId: prompt },
    })).json()) as { id: string };
    const delivery = defined(await scheduler.schedule(id), 'the schedule').Target.Input;
    // The user pauses it while its fired run waits on the queue.
    expect((await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: true } })).status).toBe(200);

    await scheduler.deliver(delivery);

    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Payrolls" skipped: the task was paused']);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0));
    expect(await (await request(account, '/scheduled-tasks')).json()).toEqual({ tasks: [] });
    expect(stack.agentcore.invocations().map(({ body }) => body)).not.toContainEqual(expect.stringContaining(prompt));
  });

  // Last: the poller backs off after the failure, which would hold up a later run.
  it('posts a run that broke off mid-stream as failed, and still fails its delivery', async () => {
    const account = owner();
    const main = await mainChat(account);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { id } = await run(account, { ...stream(...text('a1', 'Partial')), drop: true });

    const [summary] = (await posted(main)).map(({ content }) => content);
    expect(summary).toMatch(/^Scheduled task "Morning brief" failed: \S/);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.any(Error)), { timeout: 2_000 });
    const { tasks } = (await (await request(account, '/scheduled-tasks')).json()) as { tasks: { id: string; lastRun?: { status: string } }[] };
    expect(tasks.find((task) => task.id === id)?.lastRun?.status).toBe('failed');
    const threads = (await (await request(account, '/threads')).json()) as { threads: { id: string }[] };
    const sideChat = defined(threads.threads[0], 'the failed Side Chat').id;
    expect(await stack.sessionMetadata.get(account, sideChat)).not.toHaveProperty('turn_running_since');
    errors.mockRestore();
  });
});

describe('pollScheduledRuns', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A queue holding these deliveries, then none until the poller stops. */
  function queue(...bodies: string[]) {
    const deliveries = bodies.map((body, n) => [{ body, receipt: `receipt-${n}`, deliveryId: `delivery-${n}` }]);
    const deleted: string[] = [];
    const signals: AbortSignal[] = [];
    let receives = 0;
    const fake: RunQueue = {
      receive: async (signal) => {
        receives += 1;
        signals.push(signal);
        const next = deliveries.shift();
        if (next) return next;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      delete: async (receipt) => {
        deleted.push(receipt);
      },
    };
    return { fake, deleted, signals, receives: () => receives };
  }

  const neverDraining = async () => false;

  it('settles expired tasks before receiving without requiring a scheduled delivery', async () => {
    const events: string[] = [];
    const maintenance = vi.fn(async () => { events.push('maintenance'); });
    let received = false;
    const stop = pollScheduledRuns({
      receive: async (signal) => {
        if (!received) { received = true; events.push('receive'); return []; }
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      delete: async () => undefined,
    }, async () => undefined, neverDraining, undefined, maintenance);
    await vi.waitFor(() => expect(events.slice(0, 2)).toEqual(['maintenance', 'receive']));
    stop();
  });

  it('stops and reports expiration maintenance failure without deleting queued work', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, deleted, receives } = queue('{"owner":"a","taskId":"t1"}');
    const failure = new Error('Expiry storage unavailable');
    const failed = vi.fn();
    const run = vi.fn();
    const stop = pollScheduledRuns(fake, run, neverDraining, failed, async () => { throw failure; });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(failure));
    expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: expired task maintenance failed', failure);
    expect(deleted).toEqual([]);
    expect(receives()).toBe(0);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('finishes a message claimed while a long receive was in flight before stopping for drain', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let draining = false;
    const receive = vi.fn(async () => {
      draining = true;
      return [{ body: '{"owner":"a","taskId":"t1"}', receipt: 'in-flight', deliveryId: 'claimed' }];
    });
    const remove = vi.fn(async () => undefined);
    const run = vi.fn(async () => undefined);
    const stop = pollScheduledRuns({ receive, delete: remove }, run, async () => draining, undefined, async () => undefined);
    try {
      await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('in-flight'));
      expect(run).toHaveBeenCalledWith({ owner: 'a', taskId: 't1', deliveryId: 'claimed' });
      expect(receive).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith('This Chat Service task is draining; it takes no more scheduled runs');
    } finally { stop(); }
  });

  it('stops and reports queue infrastructure failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('SQS unavailable');
    const failed = vi.fn();
    const run = vi.fn();
    const receive = vi.fn(async () => { throw failure; });
    const stop = pollScheduledRuns({ receive, delete: async () => undefined }, run, neverDraining, failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(failure));
    expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: queue receive failed', failure);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('runs each delivery and then deletes it', async () => {
    const { fake, deleted } = queue('{"owner":"a","taskId":"t1"}', '{"owner":"b","taskId":"t2"}');
    const runs: ScheduledRunMessage[] = [];

    const stop = pollScheduledRuns(
      fake,
      async (message) => {
        runs.push(message);
      },
      neverDraining,
    );

    await vi.waitFor(() => expect(deleted).toEqual(['receipt-0', 'receipt-1']));
    expect(runs).toEqual([
      { owner: 'a', taskId: 't1', deliveryId: 'delivery-0' },
      { owner: 'b', taskId: 't2', deliveryId: 'delivery-1' },
    ]);
    stop();
  });

  it('leaves a failed run on the queue, logs it, and receives again after five seconds', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, deleted, receives } = queue('{"owner":"a","taskId":"t1"}');
    const failure = new Error('AgentCore is down');

    const stop = pollScheduledRuns(
      fake,
      async () => {
        throw failure;
      },
      neverDraining,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledWith('Scheduled run failed', failure);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(receives()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(receives()).toBe(2);
    expect(deleted).toEqual([]);
    stop();
  });

  it('stops receiving, without logging, once stopped', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, receives, signals } = queue();

    const stop = pollScheduledRuns(fake, async () => undefined, neverDraining);
    await vi.waitFor(() => expect(receives()).toBe(1));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(receives()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('takes no more runs once its task is draining, so a deploy hands them to the new revision', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fake, deleted, receives } = queue('{"owner":"a","taskId":"t1"}', '{"owner":"b","taskId":"t2"}');
    let draining = false;

    pollScheduledRuns(
      fake,
      async () => {
        draining = true;
      },
      async () => draining,
    );

    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith('This Chat Service task is draining; it takes no more scheduled runs'));
    expect(deleted).toEqual(['receipt-0']);
    expect(receives()).toBe(1);
  });

  it('stops before receiving and propagates an unanswered drain check to service health', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, receives } = queue('{"owner":"a","taskId":"t1"}');
    const failure = new Error('ECS DescribeTasks is unreachable');
    const failed = vi.fn();
    const run = vi.fn();
    const stop = pollScheduledRuns(fake, run, async () => { throw failure; }, failed);

    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(failure));
    expect(receives()).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: cannot tell whether this task is draining', failure);
    stop();
  });

});

describe('ecsTaskDraining', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const metadataUri = 'http://169.254.170.2/v4/container';
  const cluster = 'arn:aws:ecs:us-east-1:123456789012:cluster/chat';
  const taskArn = 'arn:aws:ecs:us-east-1:123456789012:task/chat/0123456789abcdef';

  const metadata = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }));

  /** An ECS client whose DescribeTasks answers these tasks. */
  function ecs(tasks: DescribeTasksCommandOutput['tasks']) {
    const client = new ECSClient({ region: 'us-east-1' });
    const send = vi.spyOn(client, 'send').mockImplementation(async () => ({ tasks, failures: [], $metadata: {} }));
    return { client, send };
  }

  it.each([
    ['metadata HTTP failure', 'ECS task metadata answered HTTP 503'],
    ['malformed metadata', 'ECS task metadata has no Cluster or TaskARN'],
    ['metadata network failure', 'metadata refused'],
    ['ECS denial', 'DescribeTasks refused'],
  ])('stops queue admission and reports %s', async (kind, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = metadata({ Cluster: cluster, TaskARN: taskArn });
    const { client, send } = ecs([{ taskArn, desiredStatus: 'RUNNING' }]);
    if (kind === 'metadata HTTP failure') fetch.mockResolvedValue(new Response(null, { status: 503 }));
    if (kind === 'malformed metadata') fetch.mockResolvedValue(new Response('{}'));
    if (kind === 'metadata network failure') fetch.mockRejectedValue(new Error('metadata refused'));
    if (kind === 'ECS denial') send.mockRejectedValue(new Error('DescribeTasks refused'));
    const receive = vi.fn<RunQueue['receive']>(() => new Promise(() => undefined));
    const failed = vi.fn();
    const stop = pollScheduledRuns({ receive, delete: async () => undefined }, async () => undefined, ecsTaskDraining(metadataUri, client), failed);
    try {
      await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message })));
      expect(receive).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('is never draining outside ECS', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { client, send } = ecs([]);

    expect(await ecsTaskDraining(undefined, client)()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('follows the desired status ECS describes for its own task, named by its task metadata', async () => {
    const fetch = metadata({ Cluster: cluster, TaskARN: taskArn, DesiredStatus: 'RUNNING' });
    const running = ecs([{ taskArn, desiredStatus: 'RUNNING' }]);

    expect(await ecsTaskDraining(metadataUri, running.client)()).toBe(false);
    expect(fetch).toHaveBeenCalledWith(`${metadataUri}/task`, { signal: expect.any(AbortSignal) });
    const [command, options] = running.send.mock.calls[0] as unknown as [DescribeTasksCommand, { abortSignal: AbortSignal }];
    expect(command).toBeInstanceOf(DescribeTasksCommand);
    expect(command.input).toEqual({ cluster, tasks: [taskArn] });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    // The metadata still says RUNNING while the deploy drains it; ECS says STOPPED.
    expect(await ecsTaskDraining(metadataUri, ecs([{ taskArn, desiredStatus: 'STOPPED' }]).client)()).toBe(true);
  });

  it('fails when it cannot name its task or ECS does not describe it', async () => {
    const { client } = ecs([]);
    metadata({}, 500);
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow('ECS task metadata answered HTTP 500');
    metadata({ Cluster: cluster });
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow('ECS task metadata has no Cluster or TaskARN');
    metadata({ TaskARN: taskArn });
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow('ECS task metadata has no Cluster or TaskARN');
    metadata({ Cluster: cluster, TaskARN: taskArn });
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow(`ECS describes no desired status for task ${taskArn}`);
    await expect(ecsTaskDraining(metadataUri, ecs(undefined).client)()).rejects.toThrow(`ECS describes no desired status for task ${taskArn}`);
    await expect(ecsTaskDraining(metadataUri, ecs([{ taskArn }]).client)()).rejects.toThrow(`ECS describes no desired status for task ${taskArn}`);
  });
});

describe('the SQS run queue', () => {
  it.each([
    ['a body', { ReceiptHandle: 'receipt-1' }],
    ['a receipt handle', { Body: '{"owner":"a","taskId":"t1"}' }],
    ['a stable message identity', { Body: '{"owner":"a","taskId":"t1"}', ReceiptHandle: 'receipt-1' }],
  ])('refuses a delivery without %s', async (_missing, message) => {
    const client = { send: async () => ({ Messages: [message] }) } as unknown as SQSClient;

    await expect(sqsRunQueue('https://queue.test/runs', client).receive(new AbortController().signal)).rejects.toThrow(
      'Scheduled run delivery is missing its Body, ReceiptHandle or MessageId',
    );
  });

  it('abandons a receive once its signal aborts, leaving the run queued', async () => {
    const endpoint = inject('dynamodbEndpoint');
    const runs = await createScheduledRuns(endpoint);
    const view = new SchedulerView(endpoint, runs);
    await view.deliver('{"owner":"a","taskId":"t1"}');
    const client = new SQSClient({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
    });

    await expect(sqsRunQueue(runs.queueUrl, client).receive(AbortSignal.abort())).rejects.toThrow();

    expect(await view.queued()).toBe(1);
  });
});


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
  const delivery = await store.claim(account, taskId, deliveryId, `filed-${account}`, main);
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
        new SchedulerClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
      const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: isolated.agentcore.url });
      const cartridge: ChatServiceCartridge = {
        corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
        browserEventName: 'test:browser', routes: new Hono(), requester: async () => ({ owner: account }), scheduledRequester: async (owner) => ({ owner }),
        filingUserId: (owner) => `filed-${owner}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
        credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
      };
      const deps = { runtimeNamespaceRequired: true, turnIdentity: null, cartridge, sessionMetadata: isolated.sessionMetadata,
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
        new SchedulerClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
      const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: isolated.agentcore.url });
      const cartridge: ChatServiceCartridge = {
        corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
        browserEventName: 'test:browser', routes: new Hono(), requester: async () => ({ owner: account }), scheduledRequester: async (owner) => ({ owner }),
        filingUserId: (owner) => `filed-${owner}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
        credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
      };
      const deps = { runtimeNamespaceRequired: true, turnIdentity: null, cartridge, sessionMetadata: isolated.sessionMetadata,
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
        new SchedulerClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
      const runtime = agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-east-1', endpoint: isolated.agentcore.url });
      const cartridge: ChatServiceCartridge = {
        corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], accountModel: async () => undefined,
        browserEventName: 'test:browser', routes: new Hono(), requester: async () => ({ owner: account }), scheduledRequester: async (owner) => ({ owner }),
        filingUserId: (owner) => `filed-${owner}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
        credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
      };
      // Storage refuses the first retirement, as a throttled transaction would.
      let refusals = 1;
      const retire: ScheduledTasks['retire'] = async (...args) => {
        if (refusals-- > 0) throw new Error('Retirement throttled');
        return tasks.retire(...args);
      };
      const deps = { runtimeNamespaceRequired: true, turnIdentity: null, cartridge, sessionMetadata: isolated.sessionMetadata,
        agentDocuments: new DynamoDBAgentDocuments(isolated.table.name, isolated.table.client), scheduledTasks: { get: tasks.get.bind(tasks), recordRun: tasks.recordRun.bind(tasks), retire },
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
    const endpoint = inject('dynamodbEndpoint');
    const runs = defined(claimed.scheduler, 'the Claim stack schedules tasks');
    const tasks = new ScheduledTasks(claimed.table.name, runs.runs, claimed.table.client,
      new SchedulerClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
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
      browserEventName: 'test:browser', routes: new Hono(), requester: async () => ({ owner: source }), scheduledRequester: async (account) => ({ owner: account }),
      filingUserId: (account) => `filed-${account}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const deps = { runtimeNamespaceRequired: true, turnIdentity: null, cartridge, sessionMetadata: claimed.sessionMetadata,
      agentDocuments: new DynamoDBAgentDocuments(claimed.table.name, claimed.table.client), scheduledTasks: tasks,
      upstream: sessionLifecycle(runtime, runtime.stop), invokeSessionApi: sessionApi({ localUrl: claimed.sessionApi.url }),
      summarizeTurn: async () => ({ title: 'Reserved Claim', summary: 'Completed this occurrence.' }),
    };
    await runs.fire(taskId);
    const sqs = new SQSClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
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
    await expect(store.claim(account, 'task', 'fenced-occurrence', `filed-${account}`, main)).rejects.toThrow();
    expect(await store.get(account, 'fenced-occurrence', 'task')).toBeNull();
  });

  it('retains one original durable delivery identity and refuses another task reusing it', async () => {
    const account = owner();
    const store = defined(stack.sessionMetadata.scheduledRuns, 'scheduled delivery store');
    const main = await stack.sessionMetadata.mainChat(account, `filed-${account}`);
    const original = await store.claim(account, 'task', 'same-occurrence', `filed-${account}`, main);
    await expect(store.claim(account, 'task', 'same-occurrence', `filed-${account}`, main)).rejects.toThrow();
    expect(await store.get(account, 'same-occurrence', 'task')).toMatchObject(original);
    await expect(store.get(account, 'same-occurrence', 'different-task')).rejects.toThrow('Scheduled delivery identity is invalid');
  });

  it.each(['ack failure', 'success proof failure', 'uncertain post', 'failed run', 'settled failed retry', 'before preparation', 'running Main', 'paused reservation', 'after admission', 'Claim before admission'] as const)('recovers an accepted scheduled post on replacement without another Side Chat or Main result: %s', async (failure) => {
    const account = owner();
    const task = { id: 'post-recovery', proposalId: 'post-recovery', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false };
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    const cartridge: ChatServiceCartridge = {
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
      accountModels: async () => [], accountModel: async () => undefined, browserEventName: 'test:browser', routes: new Hono(),
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
      runtimeNamespaceRequired: false, turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun: async () => undefined, retire: async () => undefined },
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
        const reserved = defined(await store.get(account, message.deliveryId, task.id), 'original reservation');
        const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
        await runScheduledTask({ ...deps, sessionMetadata: replacement,
          upstream: sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'scheduled-fixture-runtime', invoke }, async () => undefined) }, message);
        const completed = await defined(replacement.scheduledRuns, 'replacement delivery store').get(account, message.deliveryId, task.id);
        expect(completed).toMatchObject({ phase: 'completed', sideChat: reserved.sideChat, mainChat: reserved.mainChat, runId: reserved.runId, postMessageId: reserved.postMessageId });
        releaseReservation();
        await expect(original).rejects.toThrow();
        expect(recording).not.toHaveBeenCalled();
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
      accountModels: async () => [], accountModel: async () => undefined, browserEventName: 'test:browser', routes: new Hono(),
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
      runtimeNamespaceRequired: false, turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun, retire: async () => undefined },
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
      accountModels: async () => [], accountModel: async () => undefined, browserEventName: 'test:browser', routes: new Hono(),
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
      runtimeNamespaceRequired: false, turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => ({ id: 'deleted-run', proposalId: 'deleted-proposal', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false, ended: false }), recordRun: async () => undefined, retire: async () => undefined },
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
      accountModels: async () => [], accountModel: async () => undefined, browserEventName: 'test:browser', routes: new Hono(),
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
      runtimeNamespaceRequired: false, turnIdentity: null,
      summarizeTurn: async () => ({ title: 'Brief', summary: 'Completed the brief.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun: async () => undefined, retire: async () => undefined },
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
