import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from './cartridge.js';
import { accountDefaultModel } from './models.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());

const turn = (threadId: string, forwardedProps: Record<string, unknown>) =>
  JSON.stringify({
    threadId,
    runId: 'run-1',
    state: {},
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    forwardedProps,
  });

const postTurn = (body: string) =>
  stack.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe("an account's allowed models", () => {
  it("are the account's own models, then the Cartridge's, each in its order", async () => {
    const response = await stack.app.request('/agent/models');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        { key: 'plan', label: 'Plan', provider: 'openai' },
        { key: 'quick', label: 'Quick', provider: 'anthropic' },
        { key: 'thorough', label: 'Thorough', description: 'Slower, more careful', provider: 'anthropic' },
      ],
    });
  });

  it('are the ones the Cartridge gives the requesting account', async () => {
    const perAccount = await startInProcess({
      cartridge: {
        models: [{ key: 'quick', label: 'Quick', provider: 'anthropic' }],
        accountModels: async ({ owner }) => (owner === 'account-with-plan' ? [{ key: 'plan', label: 'Plan', provider: 'openai' }] : []),
      },
    });
    try {
      const listed = async (owner: string) =>
        (await (await perAccount.app.request('/agent/models', { headers: { 'x-test-owner': owner } })).json()) as {
          models: { key: string }[];
        };

      expect((await listed('account-with-plan')).models.map(({ key }) => key)).toEqual(['plan', 'quick']);
      expect((await listed('account-without-plan')).models.map(({ key }) => key)).toEqual(['quick']);

      const refused = await perAccount.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': 'account-without-plan' },
        body: turn('session-other-accounts-model', { model: 'plan' }),
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ detail: 'Model "plan" is not available to this account' });
    } finally {
      await perAccount.stop();
    }
  });

  it("leave a Turn naming a Cartridge model to run when the account's own cannot be listed, and fail one naming none", async () => {
    const failing = await startInProcess({
      cartridge: {
        accountModels: async () => {
          throw new HttpError(502, 'The plan catalog is unavailable');
        },
      },
    });
    try {
      const post = (threadId: string, forwardedProps: Record<string, unknown>) =>
        failing.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: turn(threadId, forwardedProps) });

      const named = await post('session-cartridge-model', { model: 'thorough' });
      const unnamed = await post('session-default-model', {});
      const plan = await post('session-account-model', { model: 'plan' });
      const listed = await failing.app.request('/agent/models');

      expect(named.status).toBe(200);
      await named.text();
      // Naming none, the Turn runs on the account's default, which the failed catalog leaves unknown.
      expect([unnamed.status, plan.status, listed.status]).toEqual([502, 502, 502]);
      expect(await unnamed.json()).toEqual({ detail: 'The plan catalog is unavailable' });
      expect(await listed.json()).toEqual({
        detail: 'The plan catalog is unavailable',
        cartridgeModels: [
          { key: 'quick', label: 'Quick', provider: 'anthropic' },
          { key: 'thorough', label: 'Thorough', description: 'Slower, more careful', provider: 'anthropic' },
        ],
      });
    } finally {
      await failing.stop();
    }
  });

  it('exposes Cartridge choices while preserving a classified catalog refusal', async () => {
    const failing = await startInProcess({ cartridge: { accountModels: async () => { throw new HttpError(503, 'Plan Usage was revoked'); } } });
    try {
      const response = await failing.app.request('/agent/models');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: 'Plan Usage was revoked',
        cartridgeModels: [
          { key: 'quick', label: 'Quick', provider: 'anthropic' },
          { key: 'thorough', label: 'Thorough', description: 'Slower, more careful', provider: 'anthropic' },
        ],
      });
    } finally { await failing.stop(); }
  });

  it('are served only to a request the Cartridge resolves an account for', async () => {
    const refusing = await startInProcess({
      cartridge: {
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
  it('reaches the Harness with a listed model', async () => {
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
    const response = await postTurn(turn('session-provider-first', { model: 'plan' }));

    expect(response.status).toBe(200);
    await response.text();
    expect(await threadOf('session-provider-first')).toMatchObject({ provider: 'openai' });
  });

  it("is the account's default model's when its first Turn names none", async () => {
    const response = await postTurn(turn('session-provider-default', {}));

    expect(response.status).toBe(200);
    await response.text();
    expect(await threadOf('session-provider-default')).toMatchObject({ provider: 'openai' });
  });

  it('is named when the Main Chat is replayed', async () => {
    const owner = { 'x-test-owner': 'account-main-chat-provider' };
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
    await (await postTurn(turn('session-provider-same', { model: 'quick' }))).text();

    const response = await postTurn(turn('session-provider-same', { model: 'thorough' }));

    expect(response.status).toBe(200);
    await response.text();
    expect(turnsOf('session-provider-same')).toHaveLength(2);
  });

  it.each([
    [
      "another provider's model",
      'session-provider-mixed',
      'quick',
      { model: 'plan' },
      'anthropic',
      'Model "plan" is from openai; this Session runs on anthropic models',
    ],
    [
      "no model, when the default is another provider's",
      'session-provider-mixed-default',
      'quick',
      {},
      'anthropic',
      'Model "plan" is from openai; this Session runs on anthropic models',
    ],
  ])('refuses a later Turn naming %s before the Harness hears of it', async (_, threadId, first, later, provider, detail) => {
    await (await postTurn(turn(threadId, { model: first }))).text();

    const response = await postTurn(turn(threadId, later));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail });
    expect(turnsOf(threadId)).toHaveLength(1);
    expect(await threadOf(threadId)).toMatchObject({ provider });
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
