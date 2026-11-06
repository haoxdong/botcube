import { afterEach, beforeEach, inject } from 'vitest';
import { commands, page } from 'vitest/browser';
import { animationsSettled } from './animations-settled';

declare module 'vitest' {
  export interface ProvidedContext {
    screenshotDirectory: string;
    screen: 'phone' | 'desktop';
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (reducedMotion: 'reduce' | 'no-preference') => Promise<void>;
  }
}

const REDUCE_MOTION = /-reduce-motion$/;

beforeEach(async (context) => {
  if (REDUCE_MOTION.test(context.task.name)) await commands.emulateMedia('reduce');
});

afterEach(async (context) => {
  if (REDUCE_MOTION.test(context.task.name)) await commands.emulateMedia('no-preference');
});

afterEach(async (context) => {
  const output = inject('screenshotDirectory');
  if (!output || context.task.result?.state === 'fail') return;
  await document.fonts.ready;
  await animationsSettled(document);
  await page.screenshot({
    path: `${output}/${context.task.name}-${inject('screen')}.png`,
  });
});
