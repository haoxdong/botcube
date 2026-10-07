// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpAgent, type Message } from '@ag-ui/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** No test here expects a Stop to fail. */
const unexpectedStopFailure = (error: Error) => {
  throw error;
};


const cubeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readPackageDependencies(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(cubeRoot, 'ui/web/package.json'), 'utf8'));
  return manifest.dependencies ?? {};
}

function userMessage(id: string, content: string): Message {
  return { id, role: 'user', content };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Copilot direct AG-UI configuration', () => {
  it('connects CopilotChat directly to the service without the Next.js runtime proxy', () => {
    const deps = readPackageDependencies();

    expect(existsSync(path.join(cubeRoot, 'ui/web/src/app/api/copilotkit/route.ts'))).toBe(false);
    expect(deps).toHaveProperty('@ag-ui/client');
    expect(deps).not.toHaveProperty('@copilotkit/runtime');
    expect(deps).not.toHaveProperty('@copilotkit/sqlite-runner');
    expect(deps).not.toHaveProperty('better-sqlite3');
  });

  it('documents that a raw HttpAgent retains messages when only its thread changes', () => {
    const agent = new HttpAgent({
      url: 'http://localhost:8123',
      threadId: 'thread-a',
    });
    agent.addMessage(userMessage('message-a', 'old thread context'));

    agent.threadId = 'thread-b';

    expect(agent.messages).toEqual([
      userMessage('message-a', 'old thread context'),
    ]);
  });

  it('scopes direct HttpAgents to the active conversation id and its initial messages', async () => {
    const { buildDirectAgent } = await import('./conversations.js');
    const first = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123',
      threadId: 'thread-a',
      messages: [userMessage('a1', 'first thread')],
    });
    const second = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123',
      threadId: 'thread-b',
      messages: [],
    });

    first.addMessage(userMessage('a2', 'follow-up'));

    expect(first.threadId).toBe('thread-a');
    expect(first.messages).toEqual([userMessage('a1', 'first thread'), userMessage('a2', 'follow-up')]);
    expect(second.threadId).toBe('thread-b');
    expect(second.messages).toEqual([]);
  });

  it("holds a Turn from a stream that carries neither the graph's raw events nor its state", async () => {
    const { buildDirectAgent } = await import('./conversations.js');
    const stream = [
      { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
      { type: 'TOOL_CALL_START', toolCallId: 'call-2', toolCallName: 'ls', parentMessageId: 'm-call' },
      { type: 'TOOL_CALL_END', toolCallId: 'call-2' },
      { type: 'TOOL_CALL_RESULT', messageId: 'm-result', toolCallId: 'call-2', content: '[]', role: 'tool' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm-reply', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm-reply', delta: 'Listed ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm-reply', delta: 'the files.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm-reply' },
      { type: 'RUN_FINISHED', threadId: 'session-1', runId: 'run-1' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123',
      threadId: 'session-1',
      messages: [],
      fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    });
    agent.addMessage(userMessage('u1', 'List the files'));

    await agent.runAgent();

    expect(agent.messages).toMatchObject([
      userMessage('u1', 'List the files'),
      { id: 'm-call', role: 'assistant', toolCalls: [{ id: 'call-2', function: { name: 'ls' } }] },
      { id: 'm-result', role: 'tool', toolCallId: 'call-2', content: '[]' },
      { id: 'm-reply', role: 'assistant', content: 'Listed the files.' },
    ]);
  });

  it("sends a Turn only its new message, naming the earlier messages and tool calls the client holds", async () => {
    const { buildDirectAgent } = await import('./conversations.js');
    const bodies: unknown[] = [];
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123',
      threadId: 'session-1',
      messages: [
        userMessage('m1', 'List the files'),
        { id: 'm2', role: 'assistant', content: '', toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
        { id: 'm3', role: 'tool', toolCallId: 'call-1', content: '[]' },
        { id: 'a1', role: 'activity', activityType: 'browser', content: { url: 'https://example.com' } },
        { id: 'm4', role: 'assistant', content: 'No files.' },
      ],
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(['RUN_STARTED', 'RUN_FINISHED'].map((type) => `data: ${JSON.stringify({ type, threadId: 'session-1', runId: 'run-1' })}\n\n`).join(''));
      },
    });
    agent.addMessages([userMessage('m5', 'And now?'), userMessage('m6', 'Quickly.')]);

    await agent.runAgent();

    expect(bodies).toMatchObject([{
      messages: [userMessage('m5', 'And now?'), userMessage('m6', 'Quickly.')],
      forwardedProps: { heldMessageIds: ['m1', 'm2', 'm3', 'a1', 'm4'], heldToolCallIds: ['call-1'] },
    }]);
  });

  it('preserves text between tool calls through AG-UI 1.0 streaming and saved history', async () => {
    const { buildDirectAgent } = await import('./conversations.js');
    const events = [
      { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1', protocolVersion: '1.0' },
      ...[
        { id: 'a1', text: 'I will list the files.', tool: 'list', result: [{ type: 'text', text: 'report.csv' }] },
        { id: 'a2', text: 'I found the report. I will read it.', tool: 'read', result: 'revenue,42' },
      ].flatMap(({ id, text, tool, result }) => [
        { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
        { type: 'TEXT_MESSAGE_END', messageId: id },
        { type: 'TOOL_CALL_START', toolCallId: tool, toolCallName: tool, parentMessageId: id },
        { type: 'TOOL_CALL_ARGS', toolCallId: tool, delta: '{}' },
        { type: 'TOOL_CALL_END', toolCallId: tool },
        { type: 'TOOL_CALL_RESULT', toolCallId: tool, messageId: `${tool}-result`, content: result, role: 'tool' },
      ]),
      { type: 'TEXT_MESSAGE_START', messageId: 'a3', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a3', delta: 'Revenue is 42.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'a3' },
      { type: 'RUN_FINISHED', threadId: 'session-1', runId: 'run-1', outcome: { type: 'success' } },
    ];
    const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123', threadId: 'session-1', messages: [],
      fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    });
    agent.addMessage(userMessage('u1', 'Read the report'));
    await agent.runAgent();
    const expected: Message[] = [
      userMessage('u1', 'Read the report'),
      { id: 'a1', role: 'assistant', content: 'I will list the files.', toolCalls: [{ id: 'list', type: 'function', function: { name: 'list', arguments: '{}' } }] },
      { id: 'list-result', role: 'tool', toolCallId: 'list', content: [{ type: 'text', text: 'report.csv' }] },
      { id: 'a2', role: 'assistant', content: 'I found the report. I will read it.', toolCalls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { id: 'read-result', role: 'tool', toolCallId: 'read', content: 'revenue,42' },
      { id: 'a3', role: 'assistant', content: 'Revenue is 42.' },
    ];
    expect(agent.messages).toEqual(expected);
    const reopened = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123', threadId: 'session-1', messages: JSON.parse(JSON.stringify(agent.messages)) as Message[],
    });
    reopened.setMessages([]);
    await reopened.connectAgent();
    expect(reopened.messages).toEqual(expected);
  });

  it('hydrates a raw HttpAgent with saved messages after CopilotChat connects the thread', async () => {
    const { buildDirectAgent } = await import('./conversations.js');
    const messages = [
      userMessage('m1', 'Saved question'),
      { id: 'm2', role: 'assistant', content: 'Saved answer' } satisfies Message,
    ];

    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123',
      threadId: 'saved-thread',
      messages,
    });

    expect(agent).toBeInstanceOf(HttpAgent);
    expect(agent.threadId).toBe('saved-thread');

    agent.setMessages([]);
    await agent.connectAgent();

    expect(agent.messages).toEqual(messages);
  });
});
