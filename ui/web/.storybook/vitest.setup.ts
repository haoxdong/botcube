import { afterEach, inject } from 'vitest';
import { page } from 'vitest/browser';
import { animationsSettled } from './animations-settled';

declare module 'vitest' {
  export interface ProvidedContext {
    screenshotDirectory: string;
    screen: 'phone' | 'desktop';
  }
}

afterEach(async (context) => {
  const output = inject('screenshotDirectory');
  if (!output || context.task.result?.state === 'fail') return;
  await document.fonts.ready;
  await animationsSettled(document);
  await page.screenshot({
    path: `${output}/${context.task.name}-${inject('screen')}.png`,
  });
});
