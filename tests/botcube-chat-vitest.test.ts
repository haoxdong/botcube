import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { HttpError } from '../chat/src/cartridge.js';
import { createViteServer } from 'vitest/node';
import { expect, it } from 'vitest';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

it('keeps package and local HttpError identical under the relocated native Chat config', async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'botcube-chat-vitest-')));
  const chat = join(sandbox, 'chat');
  mkdirSync(join(chat, 'src'), { recursive: true });
  mkdirSync(join(chat, 'test/fakes'), { recursive: true });
  cpSync(resolve(botcube, 'chat/vitest.config.ts'), join(chat, 'vitest.config.ts'));
  cpSync(resolve(botcube, 'chat/test/fakes/credentials.ts'), join(chat, 'test/fakes/credentials.ts'));
  cpSync(resolve(botcube, 'chat/src/cartridge.ts'), join(chat, 'src/cartridge.ts'));
  writeFileSync(join(chat, 'src/index.ts'), "export { HttpError } from './cartridge.js';\n");
  symlinkSync(resolve('node_modules'), join(sandbox, 'node_modules'), 'dir');
  const templateChat = join(sandbox, 'templates/always-on/chat');
  mkdirSync(join(templateChat, 'src'), { recursive: true });
  symlinkSync(resolve(resolve(botcube, 'templates/always-on/chat/node_modules')), join(templateChat, 'node_modules'), 'dir');
  const importer = join(templateChat, 'src/identity.ts');
  writeFileSync(importer, "export { HttpError } from 'botcube-chat';\n");
  const server = await createViteServer({ configFile: join(chat, 'vitest.config.ts'), server: { middlewareMode: true } });
  try {
    expect(server.config.root).toBe(sandbox);
    const entry = await server.pluginContainer.resolveId('botcube-chat', importer);
    if (!entry) throw new Error('botcube-chat did not resolve from the template importer');
    const bare = await server.ssrLoadModule(join(dirname(entry.id), 'cartridge.ts')) as { HttpError: typeof HttpError };
    const local = await server.ssrLoadModule(join(chat, 'src/cartridge.ts')) as { HttpError: typeof HttpError };
    expect(bare.HttpError).toBe(local.HttpError);
    expect(new bare.HttpError(503, 'fixture error')).toBeInstanceOf(local.HttpError);
    expect(entry.id).toBe(join(chat, 'src/index.ts'));
  } finally {
    await server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
