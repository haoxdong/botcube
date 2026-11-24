import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { STORYBOOK_TEST_INITIAL_GLOBALS_PROVIDE_KEY, STORYBOOK_TEST_PROVIDE_KEY } from '@storybook/addon-vitest/constants';
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
const appRoot = fileURLToPath(new URL('.', import.meta.url));
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
const visual = process.env.STORYBOOK_VISUAL_COMPARE === '1';

class VisualSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]) {
    const raw: unknown = JSON.parse(readFileSync(path.resolve(appRoot, 'visual/internal/coverage.json'), 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Visual coverage must map fixtures to states');
    const weights = new Map<string, number>();
    for (const [file, states] of Object.entries(raw)) {
      if (!Array.isArray(states)) throw new Error(`Visual states are missing for ${file}`);
      weights.set(path.resolve(appRoot, '../../..', file), states.length);
    }
    return Promise.resolve(files.toSorted((left, right) => (weights.get(right.moduleId) ?? 0) - (weights.get(left.moduleId) ?? 0)));
  }
}

const update: 'all' | 'none' = process.env.VISUAL_UPDATE === '1' ? 'all' : 'none';
const profile = process.env.UI_RENDERING_PROFILE ?? '';
const renderingDirectory = process.env.UI_RENDERING_OUTPUT ?? path.resolve(appRoot, '../../../.tmp/rendering');
const traceStories = process.env.UI_RENDERING_TRACE_STORIES;
const traceMatcher = traceStories ? new RegExp(traceStories) : undefined;
let finishTrace: (() => Promise<string>) | undefined;
if (traceMatcher && !profile) throw new Error('UI_RENDERING_TRACE_STORIES requires UI_RENDERING_PROFILE');
if (visual && traceMatcher) throw new Error('Run rendering traces separately from parallel visual comparisons');
if (screen !== 'phone' && screen !== 'desktop')
  throw new Error(`Unknown Storybook viewport ${screen}`);

export default defineConfig({
  root: appRoot,
  server: {
    fs: {
      allow: process.env.STORYBOOK_SCREENSHOT_DIR
        ? [path.resolve(process.env.STORYBOOK_SCREENSHOT_DIR)]
        : [path.resolve(appRoot, 'visual'), path.resolve(appRoot, '../../../.tmp/visual-diffs')],
    },
  },
  plugins: [
    storybookTest({
      configDir: path.resolve(appRoot, '.storybook'),
      tags: visual ? { include: ['visual'] } : { exclude: ['visual'] },
      initialGlobals: { viewport: { value: visual ? null : screen, isRotated: false } },
    }),
  ],
  test: {
    setupFiles: ['./.storybook/vitest.setup.ts'],
    fileParallelism: visual,
    ...(visual ? { maxWorkers: 4, sequence: { sequencer: VisualSequencer }, api: { allowWrite: true } } : {}),
    ...(visual ? { update } : {}),
    testTimeout: 60000,
    provide: {
      screenshotDirectory: process.env.STORYBOOK_SCREENSHOT_DIR ?? '',
      screen,
      renderingProfile: profile,
      visualCompare: visual,
      ...(visual ? { [STORYBOOK_TEST_PROVIDE_KEY]: { a11y: false } } : {}),
      renderingTrace: Boolean(traceMatcher),
    },
    browser: {
      enabled: true,
      api: { allowWrite: true },
      headless: true,
      viewport: visual ? { width: screen === 'phone' ? 390 : 1440, height: 900 } : viewports[screen].viewport,
      provider: playwright({
        contextOptions: viewports[screen],
        launchOptions: profile ? { args: renderingProfile(profile).args } : {},
      }),
      instances: visual ? (['phone', 'desktop'] as const).map(name => ({
        browser: 'chromium', name: `${name}-light`,
        viewport: { width: name === 'phone' ? 390 : 1440, height: 900 },
        provide: { screen: name, [STORYBOOK_TEST_INITIAL_GLOBALS_PROVIDE_KEY]: { viewport: { value: name, isRotated: false } } },
        provider: playwright({
          contextOptions: { ...viewports[name], viewport: { width: name === 'phone' ? 390 : 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC' },
          launchOptions: { args: renderingProfile('software').args },
        }),
      })) : [{ browser: 'chromium' }],
      expect: {
        toMatchScreenshot: {
          // Vitest leaves this timer referenced after success; hook and job deadlines still bound capture.
          ...(visual ? { timeout: 0 } : {}),
          comparatorName: 'pixelmatch',
          comparatorOptions: { threshold: 0.02, allowedMismatchedPixels: 0 },
          resolveScreenshotPath: ({ arg, ext, project }) => path.resolve(appRoot, 'visual/internal/baselines', project.name, `${arg}${ext}`),
          resolveDiffPath: ({ arg, ext, project }) => path.resolve(appRoot, '../../../.tmp/visual-diffs', project.name, `${arg}${ext}`),
        },
      },
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
        // A story set to a device's screen (.storybook/screen.ts), captured at that screen's own size: the tester page
        // grows so it does not scale the story's frame down.
        captureScreen: async (context, file: string) => {
          if (context.provider.name !== 'playwright') throw new Error('captureScreen needs Playwright');
          const size = context.page.viewportSize();
          await context.page.setViewportSize({ width: 2400, height: 1600 });
          try {
            await context.iframe.owner().screenshot({ path: file });
          } finally {
            if (size) await context.page.setViewportSize(size);
          }
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
