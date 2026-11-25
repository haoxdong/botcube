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
  it('lists the configured models and dispatches them across providers in the same Session', async () => {
    const astra = { key: 'openai-plan:gpt-6.2-astra', label: 'GPT-6.2-Astra', provider: 'openai' };
    const sol = { key: 'openai-plan:gpt-6.2-sol', label: 'GPT-6.2-Sol', provider: 'openai' };
    const opus = { key: 'opus-5.5', label: 'Opus 5.5', provider: 'anthropic' };
    const deepseek = { key: 'deepseek.v3.2', label: 'DeepSeek V3.2', provider: 'deepseek' };
    let planSlugs = ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.2-astra'];
    const owner = 'acct_plan_owner_0000000000';
    const credential = await new HttpFake((request, response) => {
      if (request.method === 'GET' && request.path === '/openai/v1/models') {
        return sendJson(response, 200, {
          models: planSlugs.map((slug) => ({ slug, display_name: slug, visibility: 'list' })),
        });
      }
      return sendJson(response, 404, {});
    }).listen();
    const signedIn = await startInProcess({
      botcube: { planUsage: { ownerAccountId: owner } },
      overrides: { models: [astra, sol, opus, deepseek] },
      env: { BOTCUBE_CREDENTIAL_SERVICE_URL: credential.url, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'test-secret' },
    });
    const headers = { 'x-test-owner': owner, 'content-type': 'application/json' };
    const list = async () => (await signedIn.app.request('/agent/models', { headers })).json();
    try {
      await signedIn.accounts.signIn(owner);
      const threadId = await signedIn.allocate(owner, 'session-anthropic-to-plan');
      const transcript: RunAgentInput['messages'] = [];
      const run = async (leg: string, provider: string, expectedModel: string, model?: string) => {
        transcript.push({ id: leg, role: 'user', content: `Look up ${leg}` });
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
          method: 'POST', headers, body: turn(threadId, model === undefined ? {} : { model }, leg, transcript),
        });
        expect(response.status).toBe(200);
        expect(sseFrames(await response.text()).map(frameData)).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'TOOL_CALL_RESULT', toolCallId: callId, content: leg }),
          expect.objectContaining({ type: 'RUN_FINISHED' }),
        ]));
        const invocation = signedIn.agentcore.invocations().at(-1);
        const dispatched = JSON.parse(invocation?.body ?? '{}') as RunAgentInput;
        expect(dispatched).toMatchObject({ threadId, forwardedProps: { model: expectedModel }, messages: transcript });
        const token = String(invocation?.headers['x-botcube-credential-invocation']);
        expect(verifyCredentialServiceInvocation('test-secret', token)).toMatchObject({
          modelProvider: provider, modelId: expectedModel.replace(/^openai-plan:/, ''),
        });
        expect(await (await signedIn.app.request(`/threads/${threadId}`, { headers })).json()).toMatchObject({ provider });
        transcript.push({ id: `call-${leg}`, role: 'assistant', toolCalls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { id: `result-${leg}`, role: 'tool', toolCallId: callId, content: leg },
          { id: `reply-${leg}`, role: 'assistant', content: `Found ${leg}` });
      };
      const refuse = async (model: string) => {
        const count = signedIn.agentcore.invocations().length;
        const response = await signedIn.app.request('/', {
          method: 'POST', headers, body: turn(threadId, { model }, 'unavailable', transcript),
        });
        expect(response.status).toBe(422);
        expect(signedIn.agentcore.invocations()).toHaveLength(count);
      };

      expect(await list()).toEqual({ models: [opus, deepseek] });
      await run('before-sign-in', 'anthropic', opus.key);
      await refuse(astra.key);

      await signedIn.accounts.recordOpenAISignIn(owner, 'openai-owner');
      expect(await list()).toEqual({ models: [astra, sol, opus, deepseek] });
      const activity = async () => (await signedIn.app.request('/activity', { headers })).json();
      await run('on-plan', 'openai', sol.key, sol.key);
      await eventually(async () => expect(await activity()).toMatchObject({
        tasks: expect.arrayContaining([{ completedAt: expect.any(String), title: 'Look up on-plan' }]),
      }));
      await run('plan-default', 'openai', astra.key);
      await run('opus', 'anthropic', opus.key, opus.key);
      await run('deepseek', 'deepseek', deepseek.key, deepseek.key);
      await refuse('openai-plan:gpt-6.1-sol');
      await refuse('sonnet-4.6');
      await refuse('opus-4.6');
      await refuse('deepseek-v3.2');

      planSlugs = ['gpt-6.2-sol', 'gpt-6.1-sol'];
      expect(await list()).toEqual({ models: [sol, opus, deepseek] });
      await refuse(astra.key);
      await run('catalog-default', 'openai', sol.key);

      await signedIn.accounts.removeOpenAISignIn(owner);
      expect(await list()).toEqual({ models: [opus, deepseek] });
      await refuse(sol.key);
      await run('after-sign-out', 'anthropic', opus.key);
      expect(credential.requests.filter(({ path }) => path === '/openai/v1/responses')).toEqual([]);
    } finally {
      await Promise.all([signedIn.stop(), credential.close()]);
    }
  });
});

describe("an account's allowed models", () => {
  it('are the ones the bot gives the requesting account', async () => {
    const perAccount = await startInProcess({
      overrides: {
        models: [{ key: 'openai-plan:plan', label: 'Plan', provider: 'openai' }, { key: 'quick', label: 'Quick', provider: 'anthropic' }],
        accountModels: async ({ owner }) => (owner === 'acct_account-with-plan' ? [{ key: 'openai-plan:plan', label: 'Plan', provider: 'openai' }] : []),
      },
    });
    try {
      const listed = async (owner: string) =>
        (await (await perAccount.app.request('/agent/models', { headers: { 'x-test-owner': owner } })).json()) as {
          models: { key: string }[];
        };

      expect((await listed('acct_account-with-plan')).models.map(({ key }) => key)).toEqual(['openai-plan:plan', 'quick']);
      expect((await listed('acct_account-without-plan')).models.map(({ key }) => key)).toEqual(['quick']);
    } finally {
      await perAccount.stop();
    }
  });

  it('reports a catalog outage and still dispatches a named Bedrock model', async () => {
    const unavailable = 'openai-plan:plan';
    const threadId = 'catalog-failed';
    const failing = await startInProcess({ overrides: (chat) => ({
      models: [{ key: unavailable, label: 'Plan', provider: 'openai' }, ...chat.models],
      accountModels: async () => { throw new HttpError(503, 'Plan catalog unavailable'); },
    }) });
    const post = (model: string) => failing.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: turn(threadId, { model }),
    });
    try {
      const responses = await Promise.all([failing.app.request('/agent/models'), post(unavailable)]);
      expect(responses.map(({ status }) => status)).toEqual([503, 503]);
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
        { detail: 'Plan catalog unavailable' }, { detail: 'Plan catalog unavailable' },
      ]);
      expect((await post('unlisted')).status).toBe(422);
      expect(failing.agentcore.invocations()).toEqual([]);

      await failing.allocate('acct_account-1', threadId);
      const bedrock = await post('quick');
      expect(bedrock.status).toBe(200);
      await bedrock.text();
      expect(failing.agentcore.invocationFor(threadId).payload.forwardedProps).toMatchObject({ model: 'quick' });
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

  it('records a provider switch once and preserves it when the next Turn is refused', async () => {
    const threadId = 'session-provider-switch';
    await stack.allocate('acct_account-1', threadId);
    await (await postTurn(turn(threadId, { model: 'quick' }, 'bedrock-turn'))).text();
    expect(await threadOf(threadId)).toMatchObject({ provider: 'anthropic' });

    const writes: unknown[] = [];
    stack.table.client.middlewareStack.add((next) => async (args) => {
      if ('ExpressionAttributeValues' in args.input) {
        const provider = args.input.ExpressionAttributeValues?.[':provider'];
        if (provider !== undefined) writes.push(provider);
      }
      return next(args);
    }, { step: 'initialize', name: 'observeTurnProviderWrites' });
    try {
      stack.agentcore.script(threadId, { kind: 'stream', frames: [
        'data: {"type":"RUN_STARTED"}',
        'data: {"type":"RUN_STARTED"}',
        'data: {"type":"RUN_FINISHED"}',
      ] });
      await (await postTurn(turn(threadId, { model: 'plan' }, 'plan-turn'))).text();
      expect(await threadOf(threadId)).toMatchObject({ provider: 'openai' });

      stack.agentcore.script(threadId, { kind: 'stream', frames: ['data: {"type":"RUN_ERROR","message":"Refused before execution"}'] });
      expect(await (await postTurn(turn(threadId, { model: 'quick' }, 'refused-turn'))).text()).toContain('Refused before execution');
      expect(await threadOf(threadId)).toMatchObject({ provider: 'openai' });
      expect(writes).toEqual(['openai']);
    } finally {
      stack.table.client.middlewareStack.remove('observeTurnProviderWrites');
    }
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
