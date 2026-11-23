import { afterEach, beforeEach, expect, inject } from 'vitest';
import { commands, page } from 'vitest/browser';
import { MotionGlobalConfig } from 'motion/react';
import { configure } from 'storybook/test';
import { animationsSettled } from './animations-settled';
import { frameTimings, startFrameSampling, stopFrameSampling } from '../../../../scripts/web-checks/frame-timings.mjs';
import type { prepareRendering } from '../../../../scripts/web-checks/rendering-profile.mjs';

type RenderingProof = Awaited<ReturnType<typeof prepareRendering>>;
type RenderingRecord = RenderingProof & { story: string; state: string; timing: ReturnType<typeof frameTimings> };
let renderingProof: RenderingProof | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    screenshotDirectory: string;
    visualCompare: boolean;
    screen: 'phone' | 'desktop';
    renderingProfile: string;
    renderingTrace: boolean;
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    resetMousePosition: () => Promise<void>;
    emulateMedia: (reducedMotion: 'reduce' | 'no-preference') => Promise<void>;
    prepareRendering: () => Promise<RenderingProof>;
    recordRendering: (record: RenderingRecord) => Promise<void>;
    startRenderingTrace: (story: string) => Promise<void>;
    finishRenderingTrace: () => Promise<void>;
  }
}

const nativeFrame = window.requestAnimationFrame.bind(window);
const REDUCE_MOTION = /-reduce-motion$/;

beforeEach(async (context) => {
  if (inject('visualCompare')) MotionGlobalConfig.skipAnimations = true;
  if (REDUCE_MOTION.test(context.task.name)) await commands.emulateMedia('reduce');
  if (inject('renderingProfile')) {
    configure({ asyncUtilTimeout: 60000 });
    renderingProof = await commands.prepareRendering();
    if (inject('renderingTrace')) {
      await commands.startRenderingTrace(context.task.name);
      performance.mark('rendering-story-start');
    }
    startFrameSampling(nativeFrame);
  }
});

afterEach(async (context) => {
  if (inject('renderingProfile') && renderingProof) {
    try {
      if (inject('renderingTrace')) performance.mark('rendering-story-end');
      const samples = stopFrameSampling();
      const timing = frameTimings(samples);
      await commands.recordRendering({ ...renderingProof, story: context.task.name, state: context.task.result?.state ?? 'unknown', timing });
      if (timing.frames < 2) throw new Error('Rendering sample has fewer than two frames');
    } finally {
      if (!inject('visualCompare')) renderingProof = undefined;
      if (inject('renderingTrace')) await commands.finishRenderingTrace();
    }
  }
  if (REDUCE_MOTION.test(context.task.name)) await commands.emulateMedia('no-preference');
});

afterEach(async (context) => {
  const output = inject('screenshotDirectory');
  if ((!output && !inject('visualCompare')) || context.task.result?.state === 'fail') return;
  if (inject('visualCompare')) {
    await commands.resetMousePosition();
    if (renderingProof?.viewport) await expect(window.innerWidth).toBe(renderingProof.viewport.width);
  }
  await document.fonts.ready;
  await animationsSettled(document, inject('visualCompare') ? [...document.querySelectorAll('[role=region], [data-slot=popover-content], [data-slot=popover-content] *, .chat-model-picker, .chat-model-picker *')] : []);
  if (inject('visualCompare')) {
    await expect(document.documentElement).toMatchScreenshot(context.task.name.replace(/[^a-zA-Z0-9-]+/g, '-'));
  }
  if (!output) return;
  await page.screenshot({
    path: `${output}/${context.task.name}-${inject('screen')}.png`,
  });
});

afterEach(async (context) => {
  if (!/^composer-shadow(?:-focused)?$/.test(context.task.name) || context.task.result?.state === 'fail') return;
  const input = document.querySelector('.chat-composer');
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
  const text = input.querySelector('textarea')?.getBoundingClientRect();
  if (!text) throw new Error('Composer text missing');
  const ink = drawing.getImageData(Math.floor(text.left * scale), Math.floor(text.top * scale), Math.floor(text.width * scale), Math.floor(text.height * scale)).data;
  await expect(ink.some((value, index) => index % 4 === 0 && value < 128)).toBe(true);
});
