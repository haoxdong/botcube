import { describe, expect, it } from 'vitest';

import { FRAME, glides, type Sample } from './glide-frames';

const onFrames = (values: [frame: number, value: number][]): Sample[] => values.map(([frame, value]) => ({ at: frame * FRAME, value }));

describe('glides', () => {
  // A phone run: no frame came at 3100ms, so one sample carries two frames of the glide.
  it('passes a glide that missed a frame', () => {
    const recorded: [at: number, value: number][] = [
      [3050.2, 204.9], [3066.9, 204.9], [3083.5, 194.6], [3116.9, 165.3], [3133.5, 150.9], [3150.2, 143.3],
      [3166.8, 139.1], [3183.5, 136.4], [3200.2, 134.6], [3216.9, 133.3], [3233.5, 132.3], [3250.2, 131.6],
      [3266.8, 131.0], [3283.5, 130.6], [3300.2, 130.3], [3316.8, 130.1], [3333.5, 129.9], [3350.2, 129.9],
    ];

    expect(glides(recorded.map(([at, value]) => ({ at, value })))).toBe(true);
  });

  it('passes a glide on time', () => {
    const values = [205, 205, 194.6, 181.8, 165.3, 150.8, 143.3, 139.1, 136.4, 134.6, 130, 130];

    expect(glides(onFrames(values.map((value, frame) => [frame, value])))).toBe(true);
  });

  it('fails a snap', () => {
    expect(glides(onFrames([[0, 205], [1, 205], [2, 130], [3, 130]]))).toBe(false);
  });

  it('fails a snap across one or two missed frames', () => {
    expect(glides(onFrames([[0, 205], [1, 205], [3, 130], [4, 130]]))).toBe(false);
    expect(glides(onFrames([[0, 205], [1, 205], [4, 130], [5, 130]]))).toBe(false);
  });

  it('fails a partial snap across a missed frame', () => {
    expect(glides(onFrames([[0, 205], [1, 205], [3, 160], [4, 140], [5, 130]]))).toBe(false);
  });

  it('throws rather than judge a move over more than three frames', () => {
    expect(() => glides(onFrames([[0, 205], [1, 205], [5, 130], [6, 130]]))).toThrow(/4 frames passed between the samples/);
  });

  it('ignores a gap while nothing moves', () => {
    expect(glides(onFrames([[0, 205], [1, 205], [12, 205], [13, 194.6], [14, 181.8], [15, 165.3], [16, 150.8], [17, 143.3], [18, 136.4], [19, 130]]))).toBe(true);
  });
});
