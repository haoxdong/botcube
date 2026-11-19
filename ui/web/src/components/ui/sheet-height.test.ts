import { expect, it } from 'vitest';
import { spring } from 'motion/react';

import { retargetVelocity } from './sheet-height';

const move = { type: 'spring', visualDuration: 0.15, bounce: 0 } as const;
const at = (from: number, to: number, velocity: number) => {
  const animation = spring({ keyframes: [from, to], ...move, velocity });
  return (ms: number) => animation.next(ms).value;
};
const highest = (sample: (ms: number) => number) => Math.max(...Array.from({ length: 600 }, (_, ms) => sample(ms)));

it('keeps the sheet moving into a target that moved mid-flight, never past it', () => {
  const growing = at(400, 600, 0);
  const [from, speed] = [growing(60), (growing(61) - growing(59)) * 500];
  const target = from + 20;
  const carried = at(from, target, retargetVelocity(from, target, speed, move.visualDuration));
  expect(highest(at(from, target, speed))).toBeGreaterThan(target + 1);
  expect(highest(carried)).toBeLessThanOrEqual(target + 0.5);
  expect(carried(16)).toBeGreaterThan(at(from, target, 0)(16));
});

it('keeps speed that points away from the new target', () => {
  expect(retargetVelocity(500, 400, 800, move.visualDuration)).toBe(800);
});
