import { describe, expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { defined } from '../test/defined.js';

describe('interactive Turn snapshot freshness', () => {
  it.each([false, true])('refreshes history after a retry with empty messages %s', async (empty) => {
    const stack = await startInProcess();
    const threadId = 'retried-history';
    const messages = [{ id: 'original-request', role: 'user', content: 'Explain this' }];
    const turn = async (runId: string, inputMessages: typeof messages) => {
      const response = await stack.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, runId, state: {}, messages: inputMessages, tools: [], context: [], forwardedProps: {} }),
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    const read = async () => {
      const response = await stack.app.request(`/threads/${threadId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ messages: [{ id: 'answer', role: 'assistant', content: 'Updated answer' }] });
      return JSON.parse(defined(stack.sessionApi.requests.at(-1), 'the history read').body);
    };
    try {
      stack.sessionApi.reply(threadId, 200, { messages: [{ id: 'answer', role: 'assistant', content: 'Updated answer' }] });
      await turn('initial-turn', messages);
      expect(await read()).toMatchObject({ operation: 'get', sessionId: threadId, userId: 'filed-account-1' });
      await turn('retry-turn', empty ? [] : messages);
      expect(await read()).toMatchObject({ operation: 'get', contains: 'retry-turn' });
      stack.agentcore.script(threadId, { kind: 'stream', frames: ['data: {"type":"RUN_STARTED"}', 'data: {"type":"RUN_ERROR","code":"PROVIDER_ERROR","message":"Provider unavailable"}'] });
      expect(await turn('failed-retry-turn', empty ? [] : messages)).toContain('PROVIDER_ERROR');
      expect(await read()).toMatchObject({ operation: 'get', contains: 'failed-retry-turn' });
      expect(await stack.sessionMetadata.turnSummaries('filed-account-1')).toEqual([
        expect.objectContaining({ session_id: threadId, message_id: 'original-request', request: 'Explain this' }),
      ]);
    } finally {
      await stack.stop();
    }
  });
});
