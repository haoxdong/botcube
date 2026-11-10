import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { HttpError, type AccountHistory } from '../chat/src/cartridge.js';
import { memoryDocuments } from '../chat/test/memory-documents.js';
import { templateAccountStore } from '../templates/always-on/chat/src/account.js';
import { templateCartridgeFactory } from '../templates/always-on/chat/src/cartridge.js';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('BotCube template Cartridge', () => {
  const history: AccountHistory = {
    delete: async () => undefined,
    transfer: async () => undefined,
    owns: async () => false,
    ownsMainChat: async () => false,
  };

  it("answers the UI file URL slot's sample file and reports an unknown one", async () => {
    const routes = templateCartridgeFactory({}, templateAccountStore({}, memoryDocuments()))(history).routes.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as 400);
      throw error;
    });
    const cookie = (await routes.request('http://localhost:8123/account/session')).headers.get('set-cookie')?.split(';')[0] ?? '';
    const headers = { Cookie: cookie };
    const answer = await routes.request('http://localhost:8123/files/download-url?name=sample.txt', { headers });
    expect(answer.status).toBe(200);
    const { url } = (await answer.json()) as { url: string };
    expect(url).toBe('http://localhost:8123/files/content?name=sample.txt');
    const file = await routes.request(url, { headers });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('Hello from BotCube.\n');
    expect((await routes.request('http://localhost:8123/files/download-url?name=missing.txt', { headers })).status).toBe(404);
  });

  it('installs the browser in the base before any Cartridge tools', () => {
    const dockerfile = readFileSync(
      resolve(botcube, 'harness/deepagents/Dockerfile'),
      'utf8',
    );

    const [base, cartridge] = dockerfile.split('FROM base AS cartridge');
    expect(base).toContain('node install.mjs /opt/browser');
    expect(base).toContain('cp "/opt/browser/$BIN" /usr/local/bin/agent-browser');
    expect(cartridge).not.toContain('/usr/local/bin/agent-browser');
    expect(dockerfile).not.toContain('if [ -f "/opt/tools/$BIN" ]');
  });

  it('keeps Harness framework imports out of the template package', () => {
    expect(existsSync(
      resolve(botcube, 'templates/always-on/src/botcube_always_on/local_harness.py'),
    )).toBe(false);
    expect(readFileSync(
      resolve(botcube, 'templates/always-on/src/botcube_always_on/harness.py'),
      'utf8',
    )).not.toContain('botcube_harness_deepagents');
  });
});
