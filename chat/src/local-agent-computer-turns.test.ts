import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { localAgentComputer } from './local-agent-computer.js';
import { startInProcess } from '../test/in-process.js';

it.each(['missing', 'starting'] as const)(
  'answers an ordinary Turn while the local computer is %s',
  { timeout: 15_000 },
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'local-turn-browser-'));
    const executable = join(directory, 'chromium');
    if (kind === 'starting')
      await writeFile(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const computer = localAgentComputer({
      history: { owns: async () => true, ownsMainChat: async () => false },
      requester: async (c) => ({ owner: c.req.header('x-test-owner') ?? 'account-1' }),
      env: { BOTCUBE_CHROMIUM_PATH: executable },
    });
    const stack = await startInProcess({ cartridge: {
      routes: computer.routes,
      invocationPayload: async (input, { owner }) => ({
        ...input,
        forwardedProps: { ...input.forwardedProps, ...(await computer.forwardedProps(owner, input.threadId)) },
      }),
      credentialProps: ['agentComputerCdpUrl'],
      turnStarting: computer.turnStarting,
      browserLiveView: computer.browserLiveView,
    } });
    const threadId = `ordinary-${kind}`;
    stack.agentcore.script(threadId, { kind: 'stream', frames: [
      'data: {"type":"RUN_STARTED"}',
      'data: {"type":"TEXT_MESSAGE_START","messageId":"answer","role":"assistant"}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Hello"}',
      'data: {"type":"TEXT_MESSAGE_END","messageId":"answer"}',
      'data: {"type":"RUN_FINISHED"}',
    ] });
    const response = Promise.resolve(stack.app.request('/', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, runId: 'ordinary-run', state: {},
        messages: [{ id: 'question', role: 'user', content: 'hello' }],
        tools: [], context: [], forwardedProps: { model: 'quick' } }),
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
      expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps.agentComputerCdpUrl)
        .toMatch(/^ws:\/\/127\.0\.0\.1:8123\/agent-computer\/cdp\?token=/);
      if (kind === 'missing') {
        await expect(computer.state('account-1', threadId)).rejects.toMatchObject({
          status: 503,
          detail: `Agent Computer failed to start: Chromium is not installed at ${executable} (ENOENT): install it or set BOTCUBE_CHROMIUM_PATH`,
        });
      }
    } finally {
      if (kind === 'missing') await expect(computer.stop()).rejects.toMatchObject({ status: 503 });
      else await computer.stop();
      await response;
      await stack.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
