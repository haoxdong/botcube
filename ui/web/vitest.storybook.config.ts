import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import type { ShownElement } from './.storybook/frames';
import type { ScriptSource } from './.storybook/script-hosts';
import { viewports } from './.storybook/viewports.js';

const resolve = createRequire(import.meta.url).resolve;
/** Requests each URL `serveScript` stands in for has had. */
const scriptRequests = new Map<string, number>();

const screen = process.env.STORYBOOK_SCREEN ?? 'desktop';
if (screen !== 'phone' && screen !== 'desktop')
  throw new Error(`Unknown Storybook viewport ${screen}`);

export default defineConfig({
  server: {
    fs: {
      allow: process.env.STORYBOOK_SCREENSHOT_DIR
        ? [path.resolve(process.env.STORYBOOK_SCREENSHOT_DIR)]
        : [],
    },
  },
  plugins: [
    storybookTest({
      configDir: path.resolve('.storybook'),
      initialGlobals: { viewport: { value: screen, isRotated: false } },
    }),
  ],
  test: {
    setupFiles: ['./.storybook/vitest.setup.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    provide: {
      screenshotDirectory: process.env.STORYBOOK_SCREENSHOT_DIR ?? '',
      screen,
    },
    browser: {
      enabled: true,
      headless: true,
      viewport: viewports[screen].viewport,
      provider: playwright({ contextOptions: viewports[screen] }),
      instances: [{ browser: 'chromium' }],
      // A story named `…-reduce-motion` runs with the OS's Reduce Motion on (vitest.setup.ts), to prove BotCube still
      // moves in full.
      commands: {
        emulateMedia: async (context, reducedMotion: 'reduce' | 'no-preference') => {
          if (context.provider.name !== 'playwright') throw new Error('emulateMedia needs Playwright');
          await context.page.emulateMedia({ reducedMotion });
        },
        // A story's stand-in for a script host (.storybook/script-hosts.ts).
        serveScript: async (context, url: string, source: ScriptSource) => {
          if (context.provider.name !== 'playwright') throw new Error('serveScript needs Playwright');
          scriptRequests.set(url, 0);
          await context.page.route(url, (route) => {
            scriptRequests.set(url, (scriptRequests.get(url) ?? 0) + 1);
            const headers = { 'access-control-allow-origin': '*' };
            return 'body' in source
              ? route.fulfill({ contentType: 'text/javascript', headers, body: source.body })
              : route.fulfill({ contentType: 'text/javascript', headers, path: resolve(source.module) });
          });
        },
        scriptRequests: async (_context, url: string) => scriptRequests.get(url) ?? 0,
        // Reads a frame a story's page cannot reach (.storybook/frames.ts).
        readFrame: async (context, name: string, selector: string): Promise<ShownElement | null> => {
          if (context.provider.name !== 'playwright') throw new Error('readFrame needs Playwright');
          let frame = context.page.frames().find((candidate) => candidate.name() === name);
          if (frame === undefined) throw new Error(`No frame is named ${name}`);
          for (let child = frame.childFrames()[0]; child !== undefined; child = child.childFrames()[0]) frame = child;
          const last = (await frame.$$(selector)).at(-1);
          if (last === undefined) return null;
          return last.evaluate((element) => ({
            text: element.textContent, color: getComputedStyle(element).color, loaded: element.ownerDocument.readyState === 'complete',
          }));
        },
        stopServingScript: async (context, url: string) => {
          if (context.provider.name !== 'playwright') throw new Error('stopServingScript needs Playwright');
          await context.page.unroute(url);
          scriptRequests.delete(url);
        },
      },
    },
  },
});
