import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());

const TURN = {
  threadId: 'session-1',
  runId: 'run-1',
  state: {},
  messages: [{ id: 'm1', role: 'user', content: 'hello' }],
  tools: [],
  context: [],
  forwardedProps: {},
};

const postTurn = (body: string) =>
  stack.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('a Turn whose body is not a RunAgentInput', () => {
  it.each([
    ['invalid JSON', '{"threadId":', 'Invalid input: expected object, received undefined'],
    ['a JSON array', '[]', 'Invalid input: expected object, received array'],
    ['JSON null', 'null', 'Invalid input: expected object, received null'],
    ['a JSON string', '"hello"', 'Invalid input: expected object, received string'],
  ])('answers the 422 schema error for %s', async (_, body, message) => {
    const response = await postTurn(body);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: [{ code: 'invalid_type', expected: 'object', message, path: [] }],
    });
  });

  it('answers the 422 schema error naming a missing field', async () => {
    const { threadId: _, ...withoutThreadId } = TURN;

    const response = await postTurn(JSON.stringify(withoutThreadId));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: [{ code: 'invalid_type', expected: 'string', message: 'Invalid input: expected string, received undefined', path: ['threadId'] }],
    });
  });
});

describe('a Turn whose lists are malformed', () => {
  it.each([
    ['no messages', { messages: undefined }, 'array', 'Invalid input: expected array, received undefined', ['messages']],
    ['tools that are not a list', { tools: 'search' }, 'array', 'Invalid input: expected array, received string', ['tools']],
    ['a message that is null', { messages: [null] }, 'object', 'Invalid input: expected object, received null', ['messages', 0]],
  ])('answers the 422 schema error for %s', async (_, fields, expected, message, path) => {
    const response = await postTurn(JSON.stringify({ ...TURN, ...fields }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: [{ code: 'invalid_type', expected, message, path }] });
  });
});

describe('a Turn with null optional fields', () => {
  it('forwards its tools, context and tool calls without them', async () => {
    const response = await postTurn(
      JSON.stringify({
        ...TURN,
        threadId: 'session-nulls',
        tools: [{ name: 'search', description: 'Search', parameters: { default: null }, metadata: null }],
        context: [{ description: 'page', value: 'home', source: null }],
        messages: [
          { id: 'm1', role: 'user', content: 'hello' },
          {
            id: 'm2',
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' }, encryptedValue: null }],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    const { payload } = stack.agentcore.invocationFor('session-nulls');
    expect(payload.tools).toEqual([{ name: 'search', description: 'Search', parameters: { default: null } }]);
    expect(payload.context).toEqual([{ description: 'page', value: 'home' }]);
    expect(payload.messages).toEqual([
      { id: 'm1', role: 'user', content: 'hello' },
      { id: 'm2', role: 'assistant', toolCalls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
    ]);
  });
});

describe('a Turn with optional forwardedProps', () => {
  it.each([['omitted', undefined], ['null', null], ['empty', {}]])('accepts %s forwardedProps and forwards its message to the Harness', async (name, forwardedProps) => {
    const threadId = `session-forwarded-props-${name}`;
    const response = await postTurn(JSON.stringify({ ...TURN, threadId, forwardedProps }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('RUN_FINISHED');
    expect(stack.agentcore.invocationFor(threadId).payload.messages).toEqual(TURN.messages);
  });
});
