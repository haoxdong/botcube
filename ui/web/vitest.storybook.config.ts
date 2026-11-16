import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import type { BrowserCommandContext } from 'vitest/node';
import type { FramePath, ShownElement } from './.storybook/frames';
import type { ScriptSource } from './.storybook/script-hosts';
import { viewports } from './.storybook/viewports.js';
import { renderingProfile, prepareRendering, recordRendering } from '../../../scripts/web-checks/rendering-profile.mjs';
import { startNativeTrace } from '../../../scripts/web-checks/native-trace.mjs';

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
  const frames = page.frames();
  const names = await Promise.all(frames.map(async (candidate) => candidate.parentFrame() === null
    ? null : (await candidate.frameElement()).getAttribute('name')));
  const frame = frames[names.indexOf(name)];
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
const profile = process.env.UI_RENDERING_PROFILE ?? '';
const renderingDirectory = process.env.UI_RENDERING_OUTPUT ?? path.resolve('../../../.tmp/rendering');
const traceStories = process.env.UI_RENDERING_TRACE_STORIES;
const traceMatcher = traceStories ? new RegExp(traceStories) : undefined;
let finishTrace: (() => Promise<string>) | undefined;
if (traceMatcher && !profile) throw new Error('UI_RENDERING_TRACE_STORIES requires UI_RENDERING_PROFILE');
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
      renderingProfile: profile,
      renderingTrace: Boolean(traceMatcher),
    },
    browser: {
      enabled: true,
      headless: true,
      viewport: viewports[screen].viewport,
      provider: playwright({
        contextOptions: viewports[screen],
        launchOptions: profile ? { args: renderingProfile(profile).args } : {},
      }),
      instances: [{ browser: 'chromium' }],
      // A story named `…-reduce-motion` runs with the OS's Reduce Motion on (vitest.setup.ts), to prove BotCube still
      // moves in full.
      commands: {
        startRenderingTrace: async (context, story: string) => {
          if (!traceMatcher?.test(story)) return;
          if (finishTrace) throw new Error('A native rendering trace is already active');
          finishTrace = await startNativeTrace(context.page, path.join(renderingDirectory, profile, screen, `${encodeURIComponent(story)}.trace.json.gz`));
        },
        finishRenderingTrace: async () => {
          const finish = finishTrace;
          try {
            if (finish) console.info('Native Chrome trace:', await finish());
          } finally {
            finishTrace = undefined;
          }
        },
        prepareRendering: async (context) => {
          if (context.provider.name !== 'playwright') throw new Error('Rendering profiles need Playwright');
          return prepareRendering(context.page, profile);
        },
        recordRendering: async (_context, record: Parameters<typeof recordRendering>[2]) => {
          await recordRendering(renderingDirectory, screen, record);
        },
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
        serveFrameHeaders: async (context, url: string, headers: Record<string, string>) => {
          if (context.provider.name !== 'playwright') throw new Error('serveFrameHeaders needs Playwright');
          await context.page.route(url, async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, headers: { ...response.headers(), ...headers } });
          });
        },
        stopFrameHeaders: async (context, url: string) => {
          if (context.provider.name !== 'playwright') throw new Error('stopFrameHeaders needs Playwright');
          await context.page.unroute(url);
        },
        clickFrameElement: async (context, name: string, selector: string, path?: FramePath) => {
          if (context.provider.name !== 'playwright') throw new Error('clickFrameElement needs Playwright');
          const frame = await findFrame(context.page, name, path);
          const before = { pages: context.page.context().pages().length, url: frame.url() };
          await frame.locator(selector).click();
          return { opened: context.page.context().pages().length - before.pages, navigated: frame.url() !== before.url };
        },
        openFrameLink: async (context, name: string, selector: string, path?: FramePath) => {
          if (context.provider.name !== 'playwright') throw new Error('openFrameLink needs Playwright');
          const frame = await findFrame(context.page, name, path);
          const link = frame.locator(selector);
          const href = await link.getAttribute('href');
          if (!href) throw new Error('The cited link has no href');
          await context.page.context().route(href, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Citation source</title>' }));
          try {
            const [popup] = await Promise.all([
              context.page.context().waitForEvent('page', { timeout: 5000 }),
              link.click(),
            ]);
            try {
              await popup.waitForLoadState();
              return { url: popup.url(), opener: await popup.evaluate(() => window.opener !== null) };
            } finally {
              await popup.close();
            }
          } finally {
            await context.page.context().unroute(href);
          }
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
