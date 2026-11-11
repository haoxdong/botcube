import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import type { BrowserCommandContext } from 'vitest/node';
import type { FramePath, ShownElement } from './.storybook/frames';
import type { ScriptSource } from './.storybook/script-hosts';
import { viewports } from './.storybook/viewports.js';

type DriverPage = BrowserCommandContext['page'];
type DriverFrame = ReturnType<DriverPage['mainFrame']>;
type DriverElement = NonNullable<Awaited<ReturnType<DriverFrame['$']>>>;

const resolve = createRequire(import.meta.url).resolve;
/** Requests each URL `serveScript` stands in for has had. */
const scriptRequests = new Map<string, number>();
/** Elements `holdFrameElement` keeps hold of, by the index it returned. */
const heldElements: DriverElement[] = [];

/** The frame a FramePath names under the frame named `name` (.storybook/frames.ts). */
async function findFrame(page: DriverPage, name: string, path: FramePath): Promise<DriverFrame> {
  const frame = page.frames().find((candidate) => candidate.name() === name);
  if (frame === undefined) throw new Error(`No frame is named ${name}`);
  return path === undefined ? deepest(frame) : titled(frame, name, path);
}

/** The first-child chain's last frame under `frame`. */
function deepest(frame: DriverFrame): DriverFrame {
  const child = frame.childFrames()[0];
  return child === undefined ? frame : deepest(child);
}

/** The frame reached from `frame` by child frames of these titles, in order. */
async function titled(frame: DriverFrame, name: string, path: readonly string[]): Promise<DriverFrame> {
  const [title, ...rest] = path;
  if (title === undefined) return frame;
  const children = frame.childFrames();
  const titles = await Promise.all(children.map(async (child) => (await child.frameElement()).getAttribute('title')));
  const child = children[titles.indexOf(title)];
  if (child === undefined) throw new Error(`No frame titled ${title} under the frame named ${name}`);
  return titled(child, name, rest);
}

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
        readFrame: async (context, name: string, selector: string, path?: FramePath): Promise<ShownElement[]> => {
          if (context.provider.name !== 'playwright') throw new Error('readFrame needs Playwright');
          const elements = await (await findFrame(context.page, name, path)).$$(selector);
          return Promise.all(elements.map((element) => element.evaluate((shown) => ({
            text: shown.textContent,
            color: getComputedStyle(shown).color,
            data: { ...(shown as HTMLElement).dataset } as Record<string, string>,
            height: shown.getBoundingClientRect().height,
            loaded: shown.ownerDocument.readyState === 'complete',
          }))));
        },
        holdFrameElement: async (context, name: string, selector: string, path?: FramePath) => {
          if (context.provider.name !== 'playwright') throw new Error('holdFrameElement needs Playwright');
          const element = await (await findFrame(context.page, name, path)).$(selector);
          if (element === null) throw new Error(`No ${selector} in the frame named ${name}`);
          heldElements.push(element);
          return heldElements.length - 1;
        },
        // A frame that reloaded took the held element's document, and the driver's handle to it, with it.
        frameElementHeld: async (_context, held: number) => {
          const element = heldElements[held];
          if (element === undefined) throw new Error(`No element is held at ${held}`);
          return element.evaluate((shown) => shown.isConnected).catch((error: unknown) => {
            if (error instanceof Error && /context was destroyed|not attached|detached/i.test(error.message)) return false;
            throw error;
          });
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
