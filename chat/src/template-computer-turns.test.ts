import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { templateCartridgeFactory } from '../../template/chat/src/cartridge.js';
import { startInProcess } from '../test/in-process.js';

it.each(['missing', 'starting'] as const)(
  'answers an ordinary Turn while the configured computer is %s',
  { timeout: 15_000 },
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'template-turn-browser-'));
    const executable = join(directory, 'chromium');
    if (kind === 'starting')
      await writeFile(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    let stopComputer: (() => Promise<void>) | undefined;
    const cartridge = templateCartridgeFactory({
      TEMPLATE_SITE_URL: 'http://127.0.0.1:1',
      TEMPLATE_CHROMIUM_PATH: executable,
    }, (stop) => { stopComputer = stop; })({
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    });
    const stack = await startInProcess({ cartridge });
    const account = await stack.app.request('/account/session');
    const cookie = account.headers.get('set-cookie')?.split(';')[0] ?? '';
    const threadId = `ordinary-${kind}`;
    stack.agentcore.script(threadId, { kind: 'stream', frames: [
      'data: {"type":"RUN_STARTED"}',
      'data: {"type":"TEXT_MESSAGE_START","messageId":"answer","role":"assistant"}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Hello"}',
      'data: {"type":"TEXT_MESSAGE_END","messageId":"answer"}',
      'data: {"type":"RUN_FINISHED"}',
    ] });
    const response = Promise.resolve(stack.app.request('/', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ threadId, runId: 'ordinary-run', state: {},
        messages: [{ id: 'question', role: 'user', content: 'hello' }],
        tools: [], context: [], forwardedProps: { model: 'echo' } }),
    }));
    try {
      const completed = await Promise.race([
        response.then(async (reply) => ({ status: reply.status, text: await reply.text() })),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Ordinary Turn waited for Chromium')), 1000); timer.unref(); }),
      ]);
      expect(completed.status).toBe(200);
      expect(completed.text).toContain('"delta":"Hello"');
      expect(completed.text).toContain('RUN_FINISHED');
      if (kind === 'starting') expect(completed.text).toContain('botcube:browser-live-view');
      if (kind === 'missing') {
        await expect.poll(async () => (await stack.app.request(
          `/agent-computer?thread_id=${threadId}`, {
            headers: { cookie },
          }
        )).status).toBe(503);
      }
    } finally {
      if (stopComputer) {
        if (kind === 'missing') await expect(stopComputer()).rejects.toMatchObject({ status: 503 });
        else await stopComputer();
      }
      await response;
      await stack.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
