import { expect, it } from 'vitest';
import { eventually } from '../test/eventually.js';

it('returns what the check returns once it passes', async () => {
  let attempts = 0;
  const value = await eventually(() => {
    attempts += 1;
    expect(attempts).toBe(3);
    return 'ready';
  });
  expect(value).toBe('ready');
});

it("fails a check that never passes before the test's timeout, with its last assertion error", async () => {
  let attempts = 0;
  await expect(eventually(() => expect(++attempts).toBe(-1))).rejects.toThrow(/^expected \d{2,} to be -1/);
});

it("fails a check still running at the test's deadline with its last assertion error", async () => {
  let attempts = 0;
  await expect(eventually(async () => {
    attempts += 1;
    if (attempts > 1) await new Promise<never>(() => {});
    expect('stalled').toBe('settled');
  })).rejects.toThrow("expected 'stalled' to be 'settled'");
});
