import { expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { HttpError } from './cartridge.js';

it.each(['Main', 'Side'])('replays a failed first %s Turn when preparation never created a Session record', async (kind) => {
  const stack = await startInProcess({ cartridge: {
    invocationPayload: async () => { throw new HttpError(503, 'Local preparation failed'); },
  } });
  try {
    const sessionId = kind === 'Main'
      ? ((await (await stack.app.request('/main-chat')).json()) as { id: string }).id
      : await stack.allocate('account-1', 'preparation-replay');
    stack.sessionApi.reply(sessionId, 404, { code: 'SESSION_NOT_FOUND', error: 'No checkpoint yet' });
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: 'first-run', state: {},
        messages: [{ id: 'question', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(503);
    expect(await stack.sessionMetadata.get('account-1', sessionId)).toMatchObject({
      turn_failure: { runId: 'first-run', code: 'TURN_PREPARATION_FAILED', message: 'Local preparation failed' },
    });
    const replay = await stack.app.request(kind === 'Main' ? '/main-chat' : `/threads/${sessionId}`);
    expect.soft(replay.status).toBe(200);
    expect.soft(await replay.json()).toMatchObject({ running: false, messages: [],
      failure: { runId: 'first-run', code: 'TURN_PREPARATION_FAILED', message: 'Local preparation failed' } });
  } finally {
    await stack.stop();
  }
});
