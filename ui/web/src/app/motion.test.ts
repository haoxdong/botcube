import { afterEach, expect, it, vi } from 'vitest';

import { glide } from './motion';

/** A View Transition that, as WebKit's can, never finishes on its own: only a skip ends it. */
function stuckTransitions() {
  const skips = vi.fn();
  document.startViewTransition = vi.fn((update?: () => void) => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    update?.();
    return {
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished,
      skipTransition: () => {
        skips();
        finish();
      },
    } as unknown as ViewTransition;
  }) as typeof document.startViewTransition;
  return skips;
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'startViewTransition');
  delete document.documentElement.dataset.glide;
});

it('skips a glide still running past its time, so taps reach the page again', async () => {
  vi.useFakeTimers();
  const skips = stuckTransitions();
  const change = vi.fn();
  glide(change);
  expect(change).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset.glide).toBe('1');
  await vi.advanceTimersByTimeAsync(799);
  expect(skips).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(skips).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset.glide).toBeUndefined();
});
