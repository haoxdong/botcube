import { afterEach, beforeEach, expect, inject } from 'vitest';
import { commands, page } from 'vitest/browser';
import { animationsSettled } from './animations-settled';
import { frameTimings, startFrameSampling, stopFrameSampling } from '../../../../scripts/web-checks/frame-timings.mjs';
import type { prepareRendering } from '../../../../scripts/web-checks/rendering-profile.mjs';

type RenderingProof = Awaited<ReturnType<typeof prepareRendering>>;
type RenderingRecord = RenderingProof & { story: string; state: string; timing: ReturnType<typeof frameTimings> };
let renderingProof: RenderingProof | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    screenshotDirectory: string;
    screen: 'phone' | 'desktop';
    renderingProfile: string;
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateMedia: (reducedMotion: 'reduce' | 'no-preference') => Promise<void>;
    prepareRendering: () => Promise<RenderingProof>;
    recordRendering: (record: RenderingRecord) => Promise<void>;
  }
}

const REDUCE_MOTION = /-reduce-motion$/;

beforeEach(async (context) => {
  if (REDUCE_MOTION.test(context.task.name)) await commands.emulateMedia('reduce');
  if (inject('renderingProfile')) {
    renderingProof = await commands.prepareRendering();
    startFrameSampling();
  }
});

afterEach(async (context) => {
  if (inject('renderingProfile') && renderingProof) {
    const timing = frameTimings(stopFrameSampling());
    await commands.recordRendering({ ...renderingProof, story: context.task.name, state: context.task.result?.state ?? 'unknown', timing });
    renderingProof = undefined;
    if (timing.frames < 2) throw new Error('Rendering sample has fewer than two frames');
  }
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
