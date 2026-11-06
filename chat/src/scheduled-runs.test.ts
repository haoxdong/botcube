import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { DeleteMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { defined } from '../test/defined.js';
import { startInProcess } from '../test/in-process.js';
import type { AgentDocuments } from './agent-documents.js';
import { DynamoDBAgentDocuments } from './agent-documents.js';
import type { ChatServiceCartridge } from './cartridge.js';
import { runScheduledTask } from './scheduled-runs.js';
import { ScheduledTasks } from './scheduled-tasks.js';
import { sessionLifecycle } from './session-lifecycle.js';
import { SessionDeletedError } from './session-metadata.js';

import { activity, mainChat, owner, posted, request, run, scheduler, signInChecks, snapshot, stack, stream, text } from '../test/scheduled-run-fixture.js';
import { motoAws } from '../test/fakes/moto.js';
import { eventually } from '../test/eventually.js';

describe('a scheduled run', () => {
  it('forwards the task timezone to its scheduled Turn', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(...text('brief', 'Local morning.')), 'Morning brief', { timezone: 'America/New_York' });
    await posted(main);
    const input = RunAgentInputSchema.parse(JSON.parse(defined(stack.agentcore.invocations().at(-1), 'scheduled invocation').body));
    expect(input.forwardedProps).toMatchObject({ timezone: 'America/New_York' });
  });

  it.each([
    [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'brief', role: 'assistant', delta: 'Chunk brief.' }],
    [snapshot([{ id: 'brief', role: 'assistant', content: 'Chunk brief.' }])],
  ])('posts the answer from a chunk or snapshot stream %j', async (event) => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(event));
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief": Chunk brief.', userId: `filed-${account}`,
    }]);
  });

  it.each([true, false])('excludes historical sign-in requests from a snapshot, with a current answer %s', async (answered) => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, { kind: 'stream', frames: () => {
      const input = RunAgentInputSchema.parse(JSON.parse(defined(stack.agentcore.invocations().at(-1), 'scheduled invocation').body));
      const events = [
        { type: 'RUN_STARTED' },
        { type: 'MESSAGES_SNAPSHOT', messages: [
          { id: 'old-user', role: 'user', content: 'Previous brief' },
          { id: 'old-answer', role: 'assistant', content: 'Sign in to continue' },
          ...input.messages,
          ...(answered ? [{ id: 'current', role: 'assistant', content: 'Current brief.' }] : []),
        ] },
        { type: 'RUN_FINISHED' },
      ];
      return events.map((event) => `data: ${JSON.stringify(event)}`);
    } });
    expect(await posted(main)).toEqual([{
      content: answered ? 'Scheduled task "Morning brief": Current brief.' : 'Scheduled task "Morning brief": finished without an answer.',
      userId: `filed-${account}`,
    }]);
    expect(signInChecks).toContainEqual({ owner: account, outputs: answered ? ['Current brief.'] : [] });
  });

  it('ignores snapshot history that predates the current request', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream({ type: 'MESSAGES_SNAPSHOT', messages: [
      { id: 'old-user', role: 'user', content: 'Previous brief' },
      { id: 'old-answer', role: 'assistant', content: 'Sign in to continue' },
    ] }));
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief": finished without an answer.', userId: `filed-${account}`,
    }]);
    expect(signInChecks).toContainEqual({ owner: account, outputs: [] });
  });

  it('detects a current snapshot sign-in request', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(snapshot([{ id: 'current', role: 'assistant', content: 'Sign in to continue' }])));
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief" could not finish: Sign in to continue', userId: `filed-${account}`,
    }]);
    expect(signInChecks).toContainEqual({ owner: account, outputs: ['Sign in to continue'] });
  });

  it('continues text from a snapshot with streamed chunks', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(
      snapshot([{ id: 'brief', role: 'assistant', content: 'Current ' }]),
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'brief', delta: 'brief.' },
    ));
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief": Current brief.', userId: `filed-${account}`,
    }]);
  });

  it('posts the latest snapshot answer', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(
      snapshot([{ id: 'brief', role: 'assistant', content: 'Draft.' }]),
      snapshot([{ id: 'brief', role: 'assistant', content: 'Final brief.' }]),
    ));
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief": Final brief.', userId: `filed-${account}`,
    }]);
  });

  it('keeps snapshot history before the current answer', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, stream(...text('current', 'Current brief.'), snapshot(
      [{ id: 'current', role: 'assistant', content: 'Current brief.' }],
      [{ id: 'old', role: 'assistant', content: 'Old brief.' }],
    )));
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief": Current brief.', userId: `filed-${account}`,
    }]);
  });

  it('expands continuation chunks and accepts CRLF frames', async () => {
    const account = owner();
    const main = await mainChat(account);
    await run(account, { kind: 'stream', frames: [
      'data: {"type":"RUN_STARTED"}\r\n\r\ndata: {"type":"TEXT_MESSAGE_CHUNK","messageId":"brief","delta":"First "}\r\n\r\ndata: {"type":"TEXT_MESSAGE_CHUNK","delta":"brief."}\r\n\r\ndata: {"type":"RUN_FINISHED"}',
    ] });
    expect(await posted(main)).toEqual([{
      content: 'Scheduled task "Morning brief": First brief.', userId: `filed-${account}`,
    }]);
  });

  it('keeps an older per-run Side Chat when an existing task next runs in its task chat', async () => {
    const account = owner();
    const main = await mainChat(account);
    const response = await request(account, '/scheduled-tasks', { method: 'POST', body: {
      title: 'Morning brief', prompt: 'Check the curve', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: 'legacy-task',
    } });
    const { id } = await response.json() as { id: string };
    const oldChat = `old-run-${account}`;
    await stack.allocate(account, oldChat);
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
      await eventually(async () => {
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
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
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
      await eventually(async () => expect(await posted(main)).toContainEqual({
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

  it("names a task's Side Chat: none before its first run, its own server-issued Session once it has", async () => {
    const account = owner();
    const main = await mainChat(account);
    const listed = async () => ((await (await request(account, '/scheduled-tasks')).json()) as { tasks: { sideChat: string | null }[] }).tasks;
    const prompt = `Side chat ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('a1', 'Done.')));
    const created = await request(account, '/scheduled-tasks', {
      method: 'POST', body: { title: 'Side', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt },
    });
    const { id, sideChat } = (await created.json()) as { id: string; sideChat: string | null };
    expect(sideChat).toBeNull();
    expect((await listed()).map((task) => task.sideChat)).toEqual([null]);

    await scheduler.fire(id);
    await posted(main);

    const [ran] = (await listed()).map((task) => task.sideChat);
    expect(ran).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ran).not.toBe(id);
    expect(stack.agentcore.invocations().filter(({ body }) => (JSON.parse(body) as { threadId: string }).threadId === ran)
      .map(({ headers }) => headers['x-amzn-bedrock-agentcore-runtime-session-id'])).toEqual([ran]);
    const edited = await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { title: 'Renamed' } });
    expect(await edited.json()).toMatchObject({ sideChat: ran });
  });

  it('moves a task whose Side Chat is from before the cutover to a new one, leaving the old one readable', async () => {
    const account = owner();
    const main = await mainChat(account);
    const prompt = `Old task ${Math.random().toString(36).slice(2)}`;
    stack.agentcore.scriptPrompt(prompt, stream(...text('a2', 'New run.')));
    const created = await request(account, '/scheduled-tasks', {
      method: 'POST', body: { title: 'Old task', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt },
    });
    const { id } = (await created.json()) as { id: string };
    await DynamoDBDocumentClient.from(stack.table.client).send(new UpdateCommand({
      TableName: stack.table.name, Key: { pk: `SESSIONS#${account}`, sk: `SESSION#${id}` },
      UpdateExpression: 'SET session_id = :id, filing_user_id = :filing, runtime_binding = :binding, runtime_generation = :generation, read_only = :read_only, scheduled_task_id = :id, title = :title, created_at = :at, updated_at = :at',
      ExpressionAttributeValues: { ':id': id, ':filing': `filed-${account}`, ':binding': 'runtime-00000000-0000-4000-8000-000000000000', ':generation': 'tracked-v1', ':read_only': true, ':title': 'Old task', ':at': '2026-10-01T00:00:00.000000+00:00' },
    }));

    await scheduler.fire(id);
    await posted(main);

    const task = ((await (await request(account, '/scheduled-tasks')).json()) as { tasks: { sideChat: string }[] }).tasks[0];
    expect(task?.sideChat).not.toBe(id);
    const threads = ((await (await request(account, '/threads')).json()) as { threads: { id: string }[] }).threads.map((thread) => thread.id);
    expect(threads).toEqual(expect.arrayContaining([id, task?.sideChat]));
    stack.sessionApi.reply(id, 200, { messages: [] });
    expect(await (await request(account, `/threads/${id}`)).json()).toMatchObject({ id, readOnly: true });
  });

  it('adds later runs to the task Side Chat and leaves it after deleting the task', async () => {
    const account = owner();
    const main = await mainChat(account);
    const { id } = await run(account, stream(...text('answer', 'The curve changed.')));
    await posted(main);
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
    const threads = async () => ((await (await request(account, '/threads')).json()) as { threads: { id: string; title: string }[] }).threads.map(({ id, title }) => ({ id, title }));
    const first = await threads();
    expect(first).toEqual([expect.objectContaining({ title: 'Morning brief' })]);
    await scheduler.fire(id);
    await eventually(async () => expect((await posted(main)).length).toBe(2));
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
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
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
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
    expect(stack.agentcore.invocations()).toHaveLength(before);
    expect(await activity(account, 0)).toEqual([]);
    expect((await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: false } })).status).toBe(200);
    await scheduler.fire(id);
    await eventually(async () => expect(await activity(account, 0)).toHaveLength(1));
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
      new SchedulerClient(motoAws()));
    const main = await mainChat(account);
    const store = defined(stack.sessionMetadata.scheduledRuns, 'delivery store');
    const delivery = await store.claim(account, id, 'pre-cutover', `filed-${account}`, main, id);
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
      corsOrigins: [], agentDocuments: templates, models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }], accountModels: async () => [], routes: new Hono(),
      accountModel: async () => undefined,
      requester: async () => ({ owner: account }), scheduledRequester: async (value) => ({ owner: value }),
      filingUserId: (value) => `filed-${value}`, invocationPayload: async (input) => ({ ...input, forwardedProps: {} }),
      credentialProps: [], signInNeeded: async () => null, authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
    };
    const invoke = vi.fn(async () => new Response('data: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn(async () => ({}));
    await runScheduledTask({
      turnIdentity: null, cartridge, sessionMetadata: stack.sessionMetadata,
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

  it.each(['expired', 'retired', 'elapsed'] as const)('rechecks an admitted delivery during setup when its window is %s', async (state) => {
    const account = owner();
    const response = await request(account, '/scheduled-tasks', { method: 'POST', body: {
      title: 'US rates', prompt: 'US rates', schedule: 'rate(1 minute)', timezone: 'UTC', endDate: '2099-01-01T00:00:00.000Z', proposalId: account,
    } });
    const { id } = await response.json() as { id: string };
    const tasks = new ScheduledTasks(stack.table.name, scheduler.runs, stack.table.client,
      new SchedulerClient(motoAws()));
    const templates = { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' };
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
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
    const invoke = vi.fn(async () => new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Rates update."}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn<import('./session-api.js').SessionApi>(async () => ({}));
    const deps = {
      turnIdentity: null,
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
      const sideChat = defined((await tasks.get(account, id))?.sideChatId, 'issued Side Chat');
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
      const session = await stack.sessionMetadata.get(account, sideChat);
      expect(session).toMatchObject({ scheduled_task_id: id });
      expect(session).not.toHaveProperty('turn_running_since');
      expect(session).not.toHaveProperty('turn_run_id');
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
      release(); await stale.catch(() => undefined);
    }
  });

  it.each([['before Starts', { startDate: '2099-01-01T00:00:00.000Z' }], ['after Ends', { endDate: '2000-01-01T00:00:00.000Z' }]] as const)('runs nothing %s while task metadata is still present', async (_, bounds) => {
    const account = owner();
    const task = { id: 'spent', proposalId: 'spent-proposal', title: 'US rates', prompt: 'US rates', schedule: 'rate(1 minute)', timezone: 'UTC', paused: false, ended: true, ...bounds };
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
    const invoke = vi.fn(async () => new Response('data: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn(async () => ({}));
    const retire = vi.fn(async () => undefined);

    await runScheduledTask({
      turnIdentity: null,
      summarizeTurn: async () => ({ title: 'US rates', summary: 'Gave a rates update.' }),
      cartridge, sessionMetadata: stack.sessionMetadata, agentDocuments: documents,
      scheduledTasks: { get: async () => task, recordRun: async () => undefined, retire, issueSideChat: async () => task.id },
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
    const prepareTurn = claimed.sessionMetadata.prepareTurn.bind(claimed.sessionMetadata);
    const recording = vi.spyOn(claimed.sessionMetadata, 'prepareTurn').mockImplementation(async (account, sessionId, turn) => {
      const complete = await prepareTurn(account, sessionId, turn);
      if (account === source && turn.running !== undefined) {
        const dispatch = complete.dispatch.bind(complete);
        complete.dispatch = async () => { const registered = await dispatch(); await claimed.history.transfer(source, destination); return registered; };
      }
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

      await eventually(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({ operation: 'post', sessionId: originalMain })));
      const listed = async () => ((await (await claimed.app.request('/scheduled-tasks', { headers: { 'x-test-owner': destination } })).json()) as { tasks: { id: string }[] }).tasks;
      await eventually(async () => expect(await listed()).toEqual([]));
    } finally {
      recording.mockRestore();
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
    const prepareTurn = claimed.sessionMetadata.prepareTurn.bind(claimed.sessionMetadata);
    const recording = vi.spyOn(claimed.sessionMetadata, 'prepareTurn').mockImplementation(async (account, sessionId, turn) => {
      const complete = await prepareTurn(account, sessionId, turn);
      if (account === source && turn.running !== undefined) {
        sideChat = sessionId;
        const dispatch = complete.dispatch.bind(complete);
        complete.dispatch = async () => {
          try {
            const registered = await dispatch();
            await claimed.history.transfer(source, destination);
            defined(admitted, 'admission result')(undefined);
            return registered;
          } catch (error) { defined(admitted, 'admission result')(error); throw error; }
        };
      }
      return complete;
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
      await eventually(() => expect(claimed.agentcore.invocationFor(sessionId).payload.forwardedProps.sessionUserId).toBe(`filed-${source}`));
      expect(await claimed.sessionMetadata.get(source, sessionId)).toBeNull();
      expect(await claimed.sessionMetadata.get(destination, sessionId)).toEqual(expect.objectContaining({ filing_user_id: `filed-${source}` }));
      const tasks = (await (await claimed.app.request('/scheduled-tasks', { headers: { 'x-test-owner': destination } })).json()) as { tasks: { id: string }[] };
      expect(tasks.tasks).toContainEqual(expect.objectContaining({ id }));
      await eventually(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({
        operation: 'post', sessionId: originalMain, userId: `filed-${source}`, content: 'Scheduled task "Claimed brief": Accepted occurrence completed.',
      })));
    } finally {
      recording.mockRestore();
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
        await eventually(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({
          operation: 'post', sessionId: main, userId: `filed-${source}`, content: 'Scheduled task "Moved result": Preserved result.',
        })));
        await eventually(async () => expect(await runs.queued()).toBe(0));
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
        await eventually(() => expect(claimed.sessionApi.events()).toContainEqual(expect.objectContaining({
          operation: 'post', sessionId: main, userId: `filed-${source}`, content: 'Scheduled task "Moved result": Preserved result.',
        })));
        await eventually(async () => expect(await runs.queued()).toBe(0));
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
    const recordTurn = stack.sessionMetadata.prepareTurn.bind(stack.sessionMetadata);
    const paused = vi.spyOn(stack.sessionMetadata, 'prepareTurn').mockImplementation(async (owner, sessionId, turn) => {
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
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
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
      await eventually(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.objectContaining({ message: 'Computer capability is unavailable' })));
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

      await eventually(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.objectContaining({ message: 'Computer capability is unavailable' })));
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
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
    expect(await (await request(account, '/scheduled-tasks')).json()).toEqual({ tasks: [] });
    expect(stack.agentcore.invocations().map(({ body }) => body)).not.toContainEqual(expect.stringContaining(prompt));
  });

  it.each(['interrupt', 'cancelled'] as const)('posts a %s outcome as failed rather than an answer', async (type) => {
    const isolated = await startInProcess({ scheduled: true });
    const account = owner();
    const call = (path: string, body?: unknown) => isolated.app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-test-owner': account },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      const { id: main } = await (await call('/main-chat')).json() as { id: string };
      const { id } = await (await call('/scheduled-tasks', {
        title: 'Morning brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', proposalId: account,
      })).json() as { id: string };
      isolated.agentcore.scriptPrompt('Brief me', { kind: 'stream', frames: [
        { type: 'RUN_STARTED' }, ...text('answer', 'Partial'),
        { type: 'RUN_FINISHED', threadId: 'session', runId: 'run',
          outcome: type === 'interrupt' ? { type, interrupts: [{ id: 'approval', reason: 'Approve the action' }] } : { type } },
      ].map((event) => `data: ${JSON.stringify(event)}`) });
      await defined(isolated.scheduler, 'the isolated schedule').fire(id);
      expect((await posted(main, isolated.sessionApi)).map(({ content }) => content)).toEqual([
        `Scheduled task "Morning brief" failed: AgentCore upstream run ended with ${type} outcome`,
      ]);
      await eventually(async () => {
        const { tasks } = await (await call('/scheduled-tasks')).json() as { tasks: { id: string; lastRun?: { status: string } }[] };
        expect(tasks.find((task) => task.id === id)?.lastRun?.status).toBe('failed');
      });
      expect(isolated.bedrock.summarizedTurns()).not.toContainEqual(expect.objectContaining({ request: 'Brief me' }));
    } finally {
      await isolated.stop();
    }
  });

  // Last: the poller backs off after the failure, which would hold up a later run.
  it('posts a run that broke off mid-stream as failed, and still fails its delivery', async () => {
    const account = owner();
    const main = await mainChat(account);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { id } = await run(account, { ...stream(...text('a1', 'Partial')), drop: true });

    const [summary] = (await posted(main)).map(({ content }) => content);
    expect(summary).toMatch(/^Scheduled task "Morning brief" failed: \S/);
    await eventually(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.any(Error)));
    const { tasks } = (await (await request(account, '/scheduled-tasks')).json()) as { tasks: { id: string; lastRun?: { status: string } }[] };
    expect(tasks.find((task) => task.id === id)?.lastRun?.status).toBe('failed');
    const threads = (await (await request(account, '/threads')).json()) as { threads: { id: string }[] };
    const sideChat = defined(threads.threads[0], 'the failed Side Chat').id;
    expect(await stack.sessionMetadata.get(account, sideChat)).not.toHaveProperty('turn_running_since');
    errors.mockRestore();
  });
});
