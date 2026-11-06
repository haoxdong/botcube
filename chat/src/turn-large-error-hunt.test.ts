import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it('clears a failed Turn running mark when the streamed error exceeds a metadata item', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const stack = await startInProcess();
  const sessionId = 'large-stream-error';
  const message = 'Provider error details\n' + 'x'.repeat(410_000);
  stack.agentcore.script(sessionId, { kind: 'stream', frames: [
    'data: {"type":"RUN_STARTED","threadId":"large-stream-error","runId":"run"}',
    `data: ${JSON.stringify({ type: 'RUN_ERROR', code: 'PROVIDER_ERROR', message })}`,
  ] });
  try {
    await stack.allocate('account-1', sessionId);
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: 'run', state: {},
        messages: [{ id: 'question', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
    });
    const streamFailure = await response.text().then(() => null, (error: unknown) => error);
    expect.soft(streamFailure).toBeNull();
    const metadata = await stack.sessionMetadata.get('account-1', sessionId);
    expect.soft(metadata).not.toHaveProperty('turn_running_since');
    expect.soft(metadata).toMatchObject({ turn_failure: { runId: 'run', code: 'PROVIDER_ERROR' } });
    stack.sessionApi.reply(sessionId, 200, { messages: [] });
    const replay = await (await stack.app.request(`/threads/${sessionId}`)).json();
    expect.soft(replay).toMatchObject({ running: false, failure: { code: 'PROVIDER_ERROR' } });
  } finally {
    await stack.stop();
    logged.mockRestore();
  }
});
