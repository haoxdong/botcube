import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it.each([{ label: 'omitted', outcome: undefined }, { label: 'legacy null', outcome: null }])('settles successful RUN_FINISHED with $label outcome', async ({ outcome }) => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const stack = await startInProcess();
  const sessionId = 'invalid-outcome';
  stack.agentcore.script(sessionId, { kind: 'stream', frames: [
    'data: {"type":"RUN_STARTED","threadId":"invalid-outcome","runId":"run"}',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Done"}',
    `data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: sessionId, runId: 'run', outcome })}`,
  ] });
  try {
    await stack.allocate('account-1', sessionId);
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: 'run', state: {},
        messages: [{ id: 'question', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
    });
    const result = await response.text().then((body) => ({ body, error: null }), (error: unknown) => ({ body: '', error }));
    expect.soft(result.error).toBeNull();
    expect.soft(result.body).toContain('RUN_FINISHED');
    expect.soft(result.body).not.toContain('RUN_ERROR');
    const metadata = await stack.sessionMetadata.get('account-1', sessionId);
    expect.soft(metadata).not.toHaveProperty('turn_running_since');
    expect.soft(metadata).not.toHaveProperty('turn_run_id');
    expect.soft(metadata).not.toHaveProperty('turn_failure');
    expect.soft(metadata).toMatchObject({ turn_completed_run_id: 'run' });
  } finally {
    await stack.stop();
    logged.mockRestore();
  }
});
