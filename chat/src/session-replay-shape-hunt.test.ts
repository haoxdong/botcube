import { expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it.each([
  { name: 'missing messages', body: {}, expected: 503 },
  { name: 'null messages', body: { messages: null }, expected: 503 },
  { name: 'empty conversation', body: { messages: [] }, expected: 200 },
])('classifies replay with $name without corrupting Turn metadata', async ({ body, expected }) => {
  const stack = await startInProcess();
  try {
    await stack.allocate('account-1', 'replay-shape');
    stack.agentcore.script('replay-shape', { kind: 'stream', frames: [
      'data: {"type":"RUN_STARTED","threadId":"replay-shape","runId":"run"}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Done"}',
      'data: {"type":"RUN_FINISHED","threadId":"replay-shape","runId":"run"}',
    ] });
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'replay-shape', runId: 'run', state: {},
        messages: [{ id: 'question', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(200);
    await response.text();
    stack.sessionApi.reply('replay-shape', 200, body);
    const replay = await stack.app.request('/threads/replay-shape');
    expect.soft(replay.status).toBe(expected);
    if (expected === 200) expect(await replay.json()).toMatchObject({ messages: [], running: false });
    const metadata = await stack.sessionMetadata.get('account-1', 'replay-shape');
    expect(metadata).toMatchObject({ turn_latest_run_id: 'run' });
    expect(metadata).not.toHaveProperty('turn_running_since');
    expect(metadata).not.toHaveProperty('turn_failure');
  } finally { await stack.stop(); }
});
