import { expect, it, onTestFinished } from 'vitest';
import { cubicBezier, spring } from 'motion/react';

import { motionTokens } from './motion-tokens';

const root = (css: string) => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = `:root { ${css} }`;
  onTestFinished(() => sheet.remove());
};

it("fits springs to the shared CSS timing references without overshoot", () => {
  root('--motion-move: 300ms; --motion-quick: 0.15s; --ease: cubic-bezier(0.32, 0.72, 0, 1);');
  expect(motionTokens()).toEqual({
    move: { type: 'spring', visualDuration: 0.15, bounce: 0 },
    quick: { type: 'spring', visualDuration: 0.075, bounce: 0 },
  });
});

it('is instant where no stylesheet sets the tokens', () => {
  const instant = { type: 'spring', visualDuration: 0, bounce: 0, duration: 0 };
  expect(motionTokens()).toEqual({ move: instant, quick: instant });
  expect(motionTokens().move).not.toHaveProperty('ease');
  expect(motionTokens().quick).not.toHaveProperty('ease');
});

it('carries incoming velocity through a shared visual-duration spring', () => {
  root('--motion-move: 300ms; --motion-quick: 150ms;');
  const sample = (velocity: number) => spring({ keyframes: [0, 100], ...motionTokens().move, velocity }).next(10).value;
  expect(sample(1000)).toBeGreaterThan(sample(0));
});

it.each([['move', 300], ['quick', 150]] as const)('keeps %s spring progress within one frame of the existing CSS pace', (kind, duration) => {
  root('--motion-move: 300ms; --motion-quick: 150ms;');
  const reference = cubicBezier(0.32, 0.72, 0, 1);
  const reaches = (sample: (ms: number) => number, progress: number) => {
    for (let ms = 0; ms <= duration * 2; ms++) if (sample(ms) >= progress) return ms;
    throw new Error('The transition did not reach the reference progress');
  };
  for (const progress of [0.1, 0.5, 0.9]) {
    const animation = spring({ keyframes: [0, 1], ...motionTokens()[kind] });
    const expected = reaches(ms => reference(ms / duration), progress);
    const actual = reaches(ms => animation.next(ms).value, progress);
    expect(Math.abs(actual - expected), `${progress * 100}% progress`).toBeLessThanOrEqual(1000 / 60);
  }
});
