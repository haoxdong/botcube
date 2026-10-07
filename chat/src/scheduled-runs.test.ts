import { DescribeTasksCommand, ECSClient, type DescribeTasksCommandOutput } from '@aws-sdk/client-ecs';
import { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from '../../../tests/chat/fakes/credentials.js';
import type { UpstreamScript } from '../../../tests/chat/fakes/fake-agentcore.js';
import { SchedulerView, createScheduledRuns } from '../../../tests/chat/fakes/scheduler.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { ecsTaskDraining, pollScheduledRuns, sqsRunQueue, type RunQueue } from './scheduled-runs.js';
import type { ScheduledRunMessage } from './scheduled-tasks.js';
import type { AgentModel } from './cartridge.js';

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
    body: { title, prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt },
  });
  const { id } = (await response.json()) as { id: string };
  if (chosen.model !== undefined) await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: chosen });
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
async function posted(sessionId: string): Promise<{ content: string; userId: string }[]> {
  for (;;) {
    const posts = stack.sessionApi
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
      const messages = stack.agentcore.invocationFor(sideChat).payload.messages as { id: string }[];
      await request(account, `/threads/${sideChat}`);
      expect(stack.sessionApi.events()).toContainEqual({ operation: 'get', sessionId: sideChat, userId: `filed-${account}`, contains: defined(messages[0], "the scheduled prompt").id });
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

  it("runs the prompt as the first Turn of a fresh Side Chat and posts the agent's last answer to the Main Chat", async () => {
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
    const post = defined(stack.sessionApi.events().find((event) => event.operation === 'post' && event.sessionId === main), 'the post');
    stack.sessionApi.reply(main, 200, { messages: [] });
    await request(account, '/main-chat');
    expect(stack.sessionApi.events()).toContainEqual({
      operation: 'get',
      sessionId: main,
      userId: `filed-${account}`,
      contains: defined('messageId' in post ? post.messageId : undefined, "the post's message ID"),
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

  it('runs on the model the task names', async () => {
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

  it("runs on a Cartridge model the task names without the account's plan catalog", async () => {
    const account = owner();
    const main = await mainChat(account);
    unavailableCatalogs.add(account);

    await run(account, stream(...text('a1', 'Done.')), 'Morning brief', { model: 'thorough' });

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
    await scheduler.deliver(delivery);
    await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0), { timeout: 2_000 });
    expect(stack.agentcore.invocations().filter(({ body }) => body.includes(prompt))).toHaveLength(1);
    expect((await posted(main)).map(({ content }) => content)).toEqual(['Scheduled task "Paused brief": Resumed execution']);
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
      await vi.waitFor(() => expect(isolated.sessionApi.events()).toContainEqual(expect.objectContaining({
        operation: 'post', sessionId: main, content: 'Scheduled task "Unavailable computer" failed: Computer capability is unavailable',
      })));
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

  // Last: the poller backs off after the failure, which would hold up a later run.
  it('posts a run that broke off mid-stream as failed, and still fails its delivery', async () => {
    const account = owner();
    const main = await mainChat(account);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await run(account, { ...stream(...text('a1', 'Partial')), drop: true });

    const [summary] = (await posted(main)).map(({ content }) => content);
    expect(summary).toMatch(/^Scheduled task "Morning brief" failed: \S/);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Scheduled run failed', expect.any(Error)), { timeout: 2_000 });
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
    const deliveries = bodies.map((body, n) => [{ body, receipt: `receipt-${n}` }]);
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
      { owner: 'a', taskId: 't1' },
      { owner: 'b', taskId: 't2' },
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
  ])('refuses a delivery without %s', async (_missing, message) => {
    const client = { send: async () => ({ Messages: [message] }) } as unknown as SQSClient;

    await expect(sqsRunQueue('https://queue.test/runs', client).receive(new AbortController().signal)).rejects.toThrow(
      'Scheduled run delivery is missing its Body or ReceiptHandle',
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
