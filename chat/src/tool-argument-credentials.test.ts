import { HttpAgent } from '@ag-ui/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { relayTurn } from './turn-stream.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ cartridge: {
    invocationPayload: async (input) => ({ ...input, forwardedProps: { signedToken: 'private-token' } }),
    credentialProps: ['signedToken'],
  } });
});
afterAll(() => stack.stop());

const toolStart = { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'execute', parentMessageId: 'm' };
const toolEnd = { type: 'TOOL_CALL_END', toolCallId: 'call' };
const args = (delta: string, toolCallId = 'call') => ({ type: 'TOOL_CALL_ARGS', toolCallId, delta });
const message = (arguments_: string) => ({ id: 'm', role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'execute', arguments: arguments_ } }] });

async function publicTurn(events: Record<string, unknown>[], messages: unknown[] = []): Promise<{ body: string; toolArgs: unknown[] }> {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const threadId = `credential-json-${Math.random()}`;
  stack.agentcore.script(threadId, { kind: 'stream', frames: [
    { type: 'RUN_STARTED', threadId, runId: 'r' }, ...events, { type: 'RUN_FINISHED', threadId, runId: 'r' },
  ].map((event) => `data: ${JSON.stringify(event)}`) });
  const response = await stack.app.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, runId: 'r', state: {}, messages, tools: [], context: [], forwardedProps: {} }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  const toolArgs: unknown[] = [];
  const client = new HttpAgent({ url: 'http://fixture.invalid', threadId, initialMessages: messages as never[],
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  await client.runAgent({ runId: 'r' }, { onToolCallEndEvent: ({ toolCallArgs }) => { toolArgs.push(toolCallArgs); } });
  return { body, toolArgs };
}

it.each([
  ['whole', ['{"token":"\\u0070rivate-token"}']],
  ['split token', ['{"token":"\\u0070riva', 'te-token"}']],
  ['split escape', ['{"token":"\\u0', '070rivate-token"}']],
  ['closing syntax later', ['{"token":"\\u0070rivate-', 'token', '"}']],
])('withholds client-decoded credentials in %s tool arguments', async (_, deltas) => {
  const { body, toolArgs } = await publicTurn([toolStart, ...deltas.map((delta) => args(delta)), toolEnd]);
  expect(toolArgs).not.toContainEqual({ token: 'private-token' });
  expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
  expect(body).not.toContain('TOOL_CALL_ARGS');
  expect(body).not.toContain('RUN_FINISHED');
});

it.each(['RUN_STARTED', 'MESSAGES_SNAPSHOT'])('withholds encoded tool arguments seeded by %s', async (type) => {
  const messages = [message('{"token":"\\u0070rivate-token"}')];
  const event = type === 'MESSAGES_SNAPSHOT' ? { type, messages } : { type, input: { messages } };
  const { body } = await publicTurn([event]);
  expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
});

it.each(['snapshot', 'history'])('retains incomplete JSON escape state from %s', async (source) => {
  const messages = [message('{"token":"\\u0')];
  const events = source === 'snapshot' ? [{ type: 'MESSAGES_SNAPSHOT', messages }] : [];
  const { body } = await publicTurn([...events, toolStart, args('070rivate-token"}'), toolEnd], source === 'history' ? messages : []);
  expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
  expect(body).not.toContain('070rivate-token');
});

it.each([
  ['raw credential', '{"token":"private-token"}', true],
  ['normal arguments', '{"token":"public-value"}', false],
  ['literal backslash escape', '{"token":"\\\\u0070rivate-token"}', false],
  ['escaped public value', '{"token":"\\u0070ublic-value"}', false],
])('preserves the established %s behavior', async (_, argument, withheld) => {
  const { body, toolArgs } = await publicTurn([toolStart, args(argument), toolEnd]);
  expect(body.includes('TURN_CREDENTIALS_IN_STREAM')).toBe(withheld);
  if (!withheld) expect(toolArgs).toContainEqual(JSON.parse(argument));
});

it('keeps JSON escape state independent for interleaved tool IDs', async () => {
  const { body, toolArgs } = await publicTurn([
    toolStart, args('{"token":"\\u0'),
    { ...toolStart, toolCallId: 'other' }, args('{"value":"public"}', 'other'), { ...toolEnd, toolCallId: 'other' },
    args('070rivate-token"}'), toolEnd,
  ]);
  expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
  expect(toolArgs).not.toContainEqual({ token: 'private-token' });
});

it('relays ordinary incomplete tool arguments before their closing syntax arrives', async () => {
  const frame = `data: ${JSON.stringify(args('{"token":"public-value'))}\n\n`;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    source = controller;
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolStart)}\n\n${frame}`));
  } });
  const response = await relayTurn({ label: 'Fixture', invoke: async () => new Response(body) }, {
    body: '{}', sessionId: 'progressive', accept: 'text/event-stream', browserEventName: 'fixture:browser',
    credentials: ['private-token'], saveAgentDocumentEdit: async () => undefined, finished: () => undefined,
    ended: async () => undefined, failed: () => undefined,
  });
  const reader = defined(response.body, 'relay stream').getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain(frame);
  source.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('AGENTCORE_UPSTREAM_STREAM_ERROR');
  expect((await reader.read()).done).toBe(true);
});
