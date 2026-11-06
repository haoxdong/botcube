import { describe, expect, it, vi } from 'vitest';
import { defined } from '../test/defined.js';
import { startInProcess } from '../test/in-process.js';

import { activity, mainChat, owner, posted, request, run, scheduler, sideChatOf, signInChecks, stack, stream, text, unavailableCatalogs } from '../test/scheduled-run-fixture.js';

describe('a scheduled run', () => {
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
      sideChat: await sideChatOf(account, id),
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
      expect(await (await call('/threads')).json()).toMatchObject({ threads: [] });
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.objectContaining({ message: 'The plan catalog is unavailable' })));
      // Its task has a Last run, but no Side Chat for its sheet to open.
      const { tasks } = (await (await call('/scheduled-tasks')).json()) as { tasks: object[] };
      expect(tasks).toEqual([expect.objectContaining({ lastRun: { at: expect.any(String), status: 'failed' }, sideChat: null })]);
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
    await vi.waitFor(async () => expect(await stack.sessionMetadata.get(account, main)).toHaveProperty('turn_completed_at'));
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
        // The Harness leaves out the proposal tool, so a run never proposes another task.
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
    await stack.allocate(account, 'topic-chat');
    await stack.sessionMetadata.recordTurn(account, 'topic-chat', { filingUserId: `filed-${account}`, title: 'My topic' });

    const { id } = await run(account, stream(...text('a1', 'All quiet.')));

    await vi.waitFor(async () => {
      const { threads } = (await (await request(account, '/threads')).json()) as { threads: { id: string; scheduled?: boolean }[] };
      expect(threads.map(({ id: thread, scheduled }) => [thread, scheduled])).toEqual(expect.arrayContaining([[await sideChatOf(account, id), true], ['topic-chat', undefined]]));
    }, { timeout: 3_000 });
  });

});
