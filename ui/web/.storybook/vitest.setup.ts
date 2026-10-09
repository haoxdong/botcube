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
    // A phone's chat scrolls the page (#3613), so the body can run far past the screen. Compare what the screen
    // shows: an element screenshot of a see-through box over the viewport.
    const viewport = document.createElement('div');
    viewport.style.cssText = 'position: fixed; inset: 0; pointer-events: none';
    document.body.append(viewport);
    try {
      await expect
        .element(page.elementLocator(viewport))
        .toMatchScreenshot(`${context.task.name}-${inject('screen')}`);
    } finally {
      viewport.remove();
    }
  }
});
