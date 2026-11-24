import type { RunAgentInput } from '@ag-ui/client';
import { verifyCredentialServiceInvocation } from './credential-service-token.js';
import { eventually } from '../test/eventually.js';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameData, sseFrames } from '../test/parity/browser.js';
import { HttpError } from './http-error.js';
import { accountDefaultModel } from './models.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

const OPENAI = { key: 'plan', label: 'Plan', provider: 'openai' };

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ overrides: {
    models: [OPENAI, { key: 'quick', label: 'Quick', provider: 'anthropic' }, { key: 'thorough', label: 'Thorough', provider: 'anthropic' }],
  } });
});
afterAll(() => stack.stop());

const turn = (threadId: string, forwardedProps: Record<string, unknown>, runId = 'run-1',
  messages: RunAgentInput['messages'] = [{ id: 'm1', role: 'user', content: 'hello' }]) =>
  JSON.stringify({
    threadId,
    runId,
    state: {},
    messages,
    tools: [],
    context: [],
    forwardedProps,
  });

const postTurn = (body: string) =>
  stack.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });


describe('stock Plan Usage', () => {
  it('lists only plan models and continues an Anthropic Session on the plan until sign-out', async () => {
    const owner = 'acct_plan_owner_0000000000';
    const limit = "Your ChatGPT plan's usage limit is reached.";
    const credential = await new HttpFake((request, response) => {
      if (request.method === 'GET' && request.path === '/openai/v1/models') {
        return sendJson(response, 200, { models: [
          { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
          { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' },
        ] });
      }
      if (request.method !== 'POST' || request.path !== '/openai/v1/responses') {
        return sendJson(response, 404, {});
      }
      const events = request.body.includes('Look up plan-limit')
        ? [{ type: 'error', error: { type: 'plan_usage', code: 'PLAN_USAGE_LIMIT_REACHED', message: limit } }]
        : [
          { type: 'response.output_item.done', item: {
            type: 'function_call', name: 'turn_summary',
            arguments: JSON.stringify({ title: 'Plan lookup', summary: 'Found the requested result' }),
          } },
          { type: 'response.completed', response: { output: [] } },
        ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    }).listen();
    const signedIn = await startInProcess({
      botcube: { planUsage: { ownerAccountId: owner } },
      env: { BOTCUBE_CREDENTIAL_SERVICE_URL: credential.url, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'test-secret' },
    });
    const headers = { 'x-test-owner': owner, 'content-type': 'application/json' };
    const list = async () => (await signedIn.app.request('/agent/models', { headers })).json();
    try {
      await signedIn.accounts.signIn(owner);
      const threadId = await signedIn.allocate(owner, 'session-anthropic-to-plan');
      const history: RunAgentInput['messages'] = [];
      const run = async (leg: string, provider: string, expectedModel: string, model?: string) => {
        history.push({ id: leg, role: 'user', content: `Look up ${leg}` });
        const callId = `tool-${leg}`;
        const frames = [{ type: 'RUN_STARTED' },
          { type: 'TOOL_CALL_START', toolCallId: callId, toolCallName: 'lookup' },
          { type: 'TOOL_CALL_ARGS', toolCallId: callId, delta: '{}' },
          { type: 'TOOL_CALL_END', toolCallId: callId },
          { type: 'TOOL_CALL_RESULT', toolCallId: callId, messageId: `result-${leg}`, content: leg, role: 'tool' },
          { type: 'TEXT_MESSAGE_START', messageId: `reply-${leg}`, role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: `reply-${leg}`, delta: `Found ${leg}` },
          { type: 'TEXT_MESSAGE_END', messageId: `reply-${leg}` },
          { type: 'RUN_FINISHED' }];
        signedIn.agentcore.script(threadId, { kind: 'stream', frames: frames.map((frame) => `data: ${JSON.stringify(frame)}`) });
        const response = await signedIn.app.request('/', {
          method: 'POST', headers, body: turn(threadId, model === undefined ? {} : { model }, leg, history),
        });
        expect(response.status).toBe(200);
        expect(sseFrames(await response.text()).map(frameData)).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'TOOL_CALL_RESULT', toolCallId: callId, content: leg }),
          expect.objectContaining({ type: 'RUN_FINISHED' }),
        ]));
        const dispatched = JSON.parse(signedIn.agentcore.invocations().at(-1)?.body ?? '{}') as RunAgentInput;
        expect(dispatched).toMatchObject({ threadId, forwardedProps: { model: expectedModel }, messages: history });
        expect(await (await signedIn.app.request(`/threads/${threadId}`, { headers })).json()).toMatchObject({ provider });
        history.push({ id: `call-${leg}`, role: 'assistant', toolCalls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { id: `result-${leg}`, role: 'tool', toolCallId: callId, content: leg },
          { id: `reply-${leg}`, role: 'assistant', content: `Found ${leg}` });
      };
      await run('before-sign-in', 'anthropic', 'quick', 'quick');

      await signedIn.accounts.recordOpenAISignIn(owner, 'openai-owner');
      expect(await list()).toEqual({ models: [
        { key: 'openai-plan:gpt-6-astra', label: 'GPT-6-Astra', provider: 'openai' },
        { key: 'openai-plan:gpt-6-sol', label: 'GPT-6-Sol', provider: 'openai' },
      ] });
      const activity = async () => (await signedIn.app.request('/activity', { headers })).json();
      await run('on-plan', 'openai', 'openai-plan:gpt-6-sol', 'openai-plan:gpt-6-sol');
      await eventually(async () => expect(await activity()).toMatchObject({
        tasks: expect.arrayContaining([{ completedAt: expect.any(String), title: 'Plan lookup', summary: 'Found the requested result' }]),
      }));
      await run('plan-limit', 'openai', 'openai-plan:gpt-6-astra');
      await eventually(async () => expect(await activity()).toMatchObject({
        tasks: expect.arrayContaining([{
          completedAt: expect.any(String), summary: 'Look up plan-limit',
          failed: `The Turn summary could not be made: ${limit}`,
        }]),
      }));
      expect(signedIn.bedrock.summarizedTurns().map(({ request }) => request)).toEqual(['Look up before-sign-in']);
      const summaries = credential.requests.filter(({ method, path }) => method === 'POST' && path === '/openai/v1/responses');
      expect(summaries.map(({ body }) => JSON.parse(body))).toEqual(['on-plan', 'plan-limit'].map((leg) => expect.objectContaining({
        model: 'gpt-6-astra', stream: true, store: false,
        input: [{ role: 'user', content: JSON.stringify({ request: `Look up ${leg}`, answer: `Found ${leg}` }) }],
      })));
      expect(summaries.map(({ headers }) => verifyCredentialServiceInvocation('test-secret', String(headers.authorization).replace(/^Bearer /, ''))))
        .toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ accountId: owner, sessionId: threadId, modelProvider: 'openai', modelId: 'gpt-6-astra' })));

      await signedIn.accounts.removeOpenAISignIn(owner);
      expect(await list()).toMatchObject({ models: [{ key: 'quick' }, { key: 'thorough' }] });
      await run('after-sign-out', 'anthropic', 'quick');
      await eventually(() => expect(signedIn.bedrock.summarizedTurns().map(({ request }) => request))
        .toEqual(['Look up before-sign-in', 'Look up after-sign-out']));
    } finally {
      await Promise.all([signedIn.stop(), credential.close()]);
    }
  });
});

describe("an account's allowed models", () => {
  it('are the ones the bot gives the requesting account', async () => {
    const perAccount = await startInProcess({
      overrides: {
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
        accountModels: async ({ owner }) => (owner === 'acct_account-with-plan' ? [{ key: 'plan', label: 'Plan', provider: 'openai' }] : []),
      },
    });
    try {
      const listed = async (owner: string) =>
        (await (await perAccount.app.request('/agent/models', { headers: { 'x-test-owner': owner } })).json()) as {
          models: { key: string }[];
        };

      expect((await listed('acct_account-with-plan')).models.map(({ key }) => key)).toEqual(['plan']);
      expect((await listed('acct_account-without-plan')).models.map(({ key }) => key)).toEqual(['quick']);
    } finally {
      await perAccount.stop();
    }
  });

  it('refuses both listing and gateway dispatch when the plan catalog fails', async () => {
    const failing = await startInProcess({ overrides: { accountModels: async () => { throw new HttpError(503, 'Plan catalog unavailable'); } } });
    try {
      const responses = await Promise.all([
        failing.app.request('/agent/models'),
        failing.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: turn('catalog-failed', { model: 'quick' }) }),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([503, 503]);
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
        { detail: 'Plan catalog unavailable' }, { detail: 'Plan catalog unavailable' },
      ]);
      expect(failing.agentcore.invocations()).toEqual([]);
    } finally {
      await failing.stop();
    }
  });

  it('are served only to a request the bot resolves an account for', async () => {
    const refusing = await startInProcess({
      overrides: {
        requester: async () => {
          throw new HttpError(401, 'Sign in first');
        },
      },
    });
    try {
      const response = await refusing.app.request('/agent/models');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ detail: 'Sign in first' });
    } finally {
      await refusing.stop();
    }
  });
});

describe('a Turn naming a model', () => {
  it.each(['quick', 'thorough', 'plan'])('run a Turn naming %s', async (model) => {
    const threadId = `session-named-${model}`;
    await stack.allocate('acct_account-1', threadId);

    const response = await postTurn(turn(threadId, { model, effort: 'high' }));

    expect(response.status).toBe(200);
    await response.text();
    expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps).toMatchObject({
      model,
      effort: 'high',
    });
  });


  it('reaches the Harness with a listed model', async () => {
    await stack.allocate('acct_account-1', 'session-listed-model');
    const response = await postTurn(turn('session-listed-model', { model: 'thorough' }));

    expect(response.status).toBe(200);
    await response.text();
    expect(stack.agentcore.invocationFor('session-listed-model').payload.forwardedProps).toMatchObject({
      model: 'thorough',
    });
  });

  it.each([
    ['an unlisted model', 'us.anthropic.claude-opus-4-6-v1', 'Model "us.anthropic.claude-opus-4-6-v1" is not available to this account'],
    ['a model that is not a string', 7, 'Model 7 is not available to this account'],
    ['a null model', null, 'Model null is not available to this account'],
  ])('is refused with %s before the Harness or a Session hears of it', async (_, model, detail) => {
    const threadId = `session-refused-${String(model)}`;

    const response = await postTurn(turn(threadId, { model }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail });
    expect(stack.agentcore.invocations().filter(({ body }) => body.includes(threadId))).toEqual([]);
    expect((await stack.app.request(`/threads/${threadId}`)).status).toBe(404);
  });

  it("runs without one on the account's default, which it names to the Harness", async () => {
    await stack.allocate('acct_account-1', 'session-no-model');
    const response = await postTurn(turn('session-no-model', {}));

    expect(response.status).toBe(200);
    await response.text();
    expect(stack.agentcore.invocationFor('session-no-model').payload.forwardedProps).toMatchObject({ model: 'plan' });
  });
});

describe("a Session's provider", () => {
  const threadOf = async (threadId: string) => (await stack.app.request(`/threads/${threadId}`)).json();
  const turnsOf = (threadId: string) => stack.agentcore.invocations().filter(({ body }) => body.includes(threadId));

  it("is recorded from its first Turn's model", async () => {
    await stack.allocate('acct_account-1', 'session-provider-first');
    const response = await postTurn(turn('session-provider-first', { model: 'plan' }));

    expect(response.status).toBe(200);
    await response.text();
    expect(await threadOf('session-provider-first')).toMatchObject({ provider: 'openai' });
  });

  it("is the account's default model's when its first Turn names none", async () => {
    await stack.allocate('acct_account-1', 'session-provider-default');
    const response = await postTurn(turn('session-provider-default', {}));

    expect(response.status).toBe(200);
    await response.text();
    expect(await threadOf('session-provider-default')).toMatchObject({ provider: 'openai' });
  });

  it('is named when the Main Chat is replayed', async () => {
    const owner = { 'x-test-owner': 'acct_account-main-chat-provider' };
    const { id } = (await (await stack.app.request('/main-chat', { headers: owner })).json()) as { id: string };
    await (
      await stack.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...owner },
        body: turn(id, { model: 'plan' }),
      })
    ).text();

    expect(await (await stack.app.request('/main-chat', { headers: owner })).json()).toEqual({
      id,
      provider: 'openai',
      messages: [],
      running: false,
    });
  });

  it("takes a later Turn on another of the provider's models", async () => {
    await stack.allocate('acct_account-1', 'session-provider-same');
    await (await postTurn(turn('session-provider-same', { model: 'quick' }))).text();

    const response = await postTurn(turn('session-provider-same', { model: 'thorough' }));

    expect(response.status).toBe(200);
    await response.text();
    expect(turnsOf('session-provider-same')).toHaveLength(2);
  });


});

describe("an account's default model", () => {
  it('is the first of its models', () => {
    expect(
      accountDefaultModel([
        { key: 'plan', label: 'Plan', provider: 'openai' },
        { key: 'quick', label: 'Quick', provider: 'anthropic' },
      ]),
    ).toEqual({ key: 'plan', label: 'Plan', provider: 'openai' });
  });

  it('fails loud when the account has no models', () => {
    expect(() => accountDefaultModel([])).toThrow(new Error('The account has no models'));
  });
});

describe('platform model parity', () => {
  it.each(['us.anthropic.claude-opus-4-6-v1', 'opus-unlisted', 'sonnet-5.5', 'opus-5.5'])('refuse unavailable picker model %s before the Harness hears of it', async (model) => {
    const threadId = `session-picker-refused-${model}`;
    await stack.allocate('acct_account-1', threadId);

    const response = await postTurn(turn(threadId, { model }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: `Model "${model}" is not available to this account`,
    });
    expect(stack.agentcore.invocations().filter(({ body }) => body.includes(threadId))).toEqual([]);
  });

  it("end a plan Turn with the Harness's classified Plan Usage error, as it named it", async () => {
    const threadId = 'session-classified-plan-error';
    await stack.allocate('acct_account-1', threadId);
    const runError = {
      type: 'RUN_ERROR',
      message:
        "Your ChatGPT plan's usage limit is reached; wait, or check ChatGPT Settings > Usage " +
        '(OpenAI subscription_sharing_usage_limit_exceeded).',
      code: 'PLAN_USAGE_LIMIT_REACHED',
    };
    stack.agentcore.script(threadId, { kind: 'stream', frames: [`data: ${JSON.stringify(runError)}`] });

    const response = await postTurn(turn(threadId, { model: 'plan' }));

    expect(response.status).toBe(200);
    expect(sseFrames(await response.text()).map(frameData)).toEqual([runError]);
  });

});
