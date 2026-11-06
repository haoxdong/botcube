import { expect, it, vi } from 'vitest';
import { relayTurn } from './turn-stream.js';
import type { Upstream } from './upstream.js';

it('keeps a completed answer successful if the upstream connection resets after RUN_FINISHED', async () => {
  const encoder = new TextEncoder();
  const events = [
    { type: 'RUN_STARTED', threadId: 'session', runId: 'run' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Done.' },
    { type: 'RUN_FINISHED', threadId: 'session', runId: 'run', outcome: { type: 'success' } },
  ];
  let index = 0;
  const upstream: Upstream = {
    label: 'Local test',
    async invoke() {
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const event = events[index++];
          if (event === undefined) controller.error(new Error('connection reset after completion'));
          else controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const finished = vi.fn();
  const failed = vi.fn();
  const ended = vi.fn(async () => undefined);
  const response = await relayTurn(upstream, {
    body: '{}', sessionId: 'session', accept: 'text/event-stream',
    credentials: [], finished, failed, ended, saveAgentDocumentEdit: async () => undefined,
  });
  const body = await response.text();
  expect.soft(body).toContain('RUN_FINISHED');
  expect.soft(body).not.toContain('RUN_ERROR');
  expect.soft(finished).toHaveBeenCalledExactlyOnceWith('Done.');
  expect.soft(failed).not.toHaveBeenCalled();
  expect.soft(ended).toHaveBeenCalledExactlyOnceWith(undefined);
});
