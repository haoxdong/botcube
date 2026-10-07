import { afterEach, expect, inject } from 'vitest';
import { page } from 'vitest/browser';
import { animationsSettled } from './animations-settled';

declare module 'vitest' {
  export interface ProvidedContext {
    screenshotDirectory: string;
    screen: 'phone' | 'desktop';
    compareScreenshots: boolean;
  }
}

afterEach(async (context) => {
  await document.fonts.ready;
  await animationsSettled(document);
  const output = inject('screenshotDirectory');
  if (output && context.task.result?.state !== 'fail') {
    await page.screenshot({
      path: `${output}/${context.task.name}-${inject('screen')}.png`,
    });
  }
  if (inject('compareScreenshots') && context.task.result?.state !== 'fail') {
    await expect
      .element(page.elementLocator(document.body))
      .toMatchScreenshot(`${context.task.name}-${inject('screen')}`);
  }
});
