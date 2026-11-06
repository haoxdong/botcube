import { describe, expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';

describe('Turn summary settlement after RUN_FINISHED', () => {
  it.each([
    { deleted: false, modelFails: false },
    { deleted: true, modelFails: false },
    { deleted: false, modelFails: true },
    { deleted: true, modelFails: true },
  ])('settles a summary with deletion $deleted and model failure $modelFails', async ({ deleted, modelFails }) => {
    let release = () => undefined as void;
    let enter = () => undefined as void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const model = await new HttpFake(async (_request, response) => {
      enter();
      await pending;
      if (modelFails) {
        sendJson(response, 500, { message: 'Summary model unavailable' });
        return;
      }
      sendJson(response, 200, {
        output: { message: { content: [{ toolUse: { name: 'turn_summary', input: { title: 'Compared rates', summary: 'Compared the yields' } } }] } },
      });
    }).listen();
    const stack = await startInProcess({ config: { turnSummaryModel: { region: 'us-east-1', url: model.url } } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await stack.allocate('account-1', 'summary-lifecycle');
      const response = await stack.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: 'summary-lifecycle', runId: 'run-1', state: {},
          messages: [{ id: 'message-1', role: 'user', content: 'Compare rates' }],
          tools: [], context: [], forwardedProps: {},
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('RUN_FINISHED');
      await entered;
      if (deleted) {
        expect((await stack.app.request('/threads/summary-lifecycle', { method: 'DELETE' })).status).toBe(204);
      }
      release();
      await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.stringContaining('summary_failed=')));
      const alarms = errors.mock.calls.filter(([message]) => String(message).startsWith('Turn summary failed'));
      if (modelFails) {
        expect(alarms).toEqual([
          ['Turn summary failed session_id=summary-lifecycle', new Error('The summary model answered HTTP 500')],
        ]);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('summary_failed=true'));
      } else {
        expect(alarms).toEqual([]);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('summary_failed=false'));
      }
      if (deleted) {
        expect((await stack.app.request('/threads/summary-lifecycle')).status).toBe(404);
        expect(await stack.sessionMetadata.turnSummaries('filed-account-1')).toEqual([]);
      } else if (modelFails) {
        expect(await stack.sessionMetadata.turnSummaries('filed-account-1')).toMatchObject([
          { failed: 'The Turn summary could not be made: The summary model answered HTTP 500' },
        ]);
        expect(await (await stack.app.request('/threads/summary-lifecycle')).json()).toMatchObject({
          failure: { code: 'TURN_SUMMARY_FAILED' },
        });
      } else {
        expect(await stack.sessionMetadata.turnSummaries('filed-account-1')).toMatchObject([
          { title: 'Compared rates', summary: 'Compared the yields' },
        ]);
      }
    } finally {
      release();
      await stack.stop();
      await model.close();
      errors.mockRestore();
      info.mockRestore();
    }
  });
});
