import { beforeEach, expect, vi } from 'vitest';

const image = vi.hoisted((): { settings: string | undefined; baseline: string | undefined } => ({ settings: undefined, baseline: undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: (...args: Parameters<typeof fs.existsSync>) => args[0] === '/bot/bot.yaml' || fs.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== '/bot/bot.yaml') return fs.readFileSync(...args);
      return image.settings ?? fs.readFileSync(new URL('../../examples/bot/bot.yaml', import.meta.url), 'utf8');
    },
  };
});

beforeEach(() => { image.settings = image.baseline; });

export function stageBotImage(settings: unknown): void {
  image.settings = JSON.stringify(settings);
  if (!expect.getState().currentTestName) image.baseline = image.settings;
}
