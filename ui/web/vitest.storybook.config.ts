import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { viewports } from './.storybook/viewports.js';

const screen = process.env.STORYBOOK_SCREEN ?? 'desktop';
const compareScreenshots = process.env.STORYBOOK_SCREENSHOTS === 'compare';
if (screen !== 'phone' && screen !== 'desktop')
  throw new Error(`Unknown screenshot viewport ${screen}`);

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
      compareScreenshots,
    },
    browser: {
      enabled: true,
      headless: true,
      viewport: viewports[screen].viewport,
      provider: playwright({
        contextOptions: viewports[screen],
        launchOptions: process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : {},
      }),
      instances: [{ browser: 'chromium' }],
      expect: {
        toMatchScreenshot: {
          // One baseline per state and viewport beside the stories, rendered in CI's Playwright image.
          resolveScreenshotPath: ({ root, testFileDirectory, arg, ext }) =>
            path.join(root, testFileDirectory, '__screenshots__', `${arg}${ext}`),
          resolveDiffPath: ({ root, attachmentsDir, arg, ext }) =>
            path.join(root, attachmentsDir, 'screenshots', `${arg}${ext}`),
        },
      },
    },
  },
});
