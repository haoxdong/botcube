export type Sample = { at: number; value: number };

export const FRAME = 1000 / 60;

const MOST_PER_FRAMES = [0.3, 0.5, 0.65];

export function distance(samples: Sample[]) {
  return Math.abs((samples.at(-1)?.value ?? 0) - (samples[0]?.value ?? 0));
}

// Headless Chromium misses frames at a phone's 2x scale, so one sample can carry several frames of a glide.
export function glides(samples: Sample[]) {
  const whole = distance(samples);
  const pairs = samples.slice(1).map((after, i) => ({ before: samples.at(i) ?? after, after }));
  return pairs.every(({ before, after }) => {
    const step = Math.abs(after.value - before.value);
    if (step < 0.01) return true;
    const frames = Math.max(1, Math.round((after.at - before.at) / FRAME));
    const most = MOST_PER_FRAMES.at(frames - 1);
    if (most === undefined)
      throw new Error(`${frames} frames passed between the samples at ${before.at}ms and ${after.at}ms, too many to tell a glide from a snap`);
    return step <= most * whole;
  });
}
