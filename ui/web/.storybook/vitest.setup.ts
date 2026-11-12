import { afterEach, beforeEach, expect, inject } from 'vitest';
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

afterEach(async (context) => {
  if (!/^composer-shadow(?:-focused)?$/.test(context.task.name) || context.task.result?.state === 'fail') return;
  const input = document.querySelector('.copilotKitInput');
  if (!input) throw new Error('Composer missing');
  await animationsSettled(document);
  const box = input.getBoundingClientRect();
  const screenshot = await page.screenshot({ save: false });
  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${screenshot}`)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const drawing = canvas.getContext('2d');
  if (!drawing) throw new Error('Screenshot canvas missing');
  drawing.drawImage(image, 0, 0);
  image.close();
  const scale = canvas.width / window.innerWidth;
  const y = Math.floor((box.bottom + 4) * scale);
  const shadow = drawing.getImageData(Math.floor((box.left + box.width / 2) * scale), y, 1, 1).data;
  const background = drawing.getImageData(0, y, 1, 1).data;
  await expect(shadow[0]).toBeLessThan(background[0] ?? 0);
});
