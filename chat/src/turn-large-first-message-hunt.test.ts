import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it.each(['Main', 'Side', 'Existing Side'])('accepts a large pasted message in %s Chat without a metadata admission failure', async (kind) => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const stack = await startInProcess();
  const content = 'Summarize this report.\n' + 'Report paragraph. '.repeat(25_000);
  try {
    const sessionId = kind === 'Main'
      ? ((await (await stack.app.request('/main-chat')).json()) as { id: string }).id
      : await stack.allocate('account-1', 'large-first-message');
    if (kind === 'Existing Side') {
      const first = await stack.app.request('/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: sessionId, runId: 'short-first-run', state: {},
          messages: [{ id: 'initial-question', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
      });
      expect(first.status).toBe(200);
      await first.text();
    }
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: 'first-run', state: {},
        messages: [{ id: 'question', role: 'user', content }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('RUN_FINISHED');
    expect(JSON.parse(stack.agentcore.invocations().at(-1)?.body ?? '{}')).toMatchObject({ messages: [{ id: 'question', role: 'user', content }] });
  } finally {
    await stack.stop();
    logged.mockRestore();
  }
});
