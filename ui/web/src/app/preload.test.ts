import { afterEach, expect, it, vi } from 'vitest';
import { idlePreload } from './preload';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('loads once, when the page is idle, however often it is asked', () => {
  const idle: (() => void)[] = [];
  vi.stubGlobal('requestIdleCallback', (run: () => void) => idle.push(run));
  const load = vi.fn(() => Promise.resolve());
  const preload = idlePreload(load);
  preload();
  preload();
  expect(load).not.toHaveBeenCalled();
  idle.forEach((run) => run());
  expect(load).toHaveBeenCalledOnce();
});

it('falls back to a timer where the browser has no idle callback', () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestIdleCallback', undefined);
  const load = vi.fn(() => Promise.resolve());
  idlePreload(load)();
  vi.runAllTimers();
  expect(load).toHaveBeenCalledOnce();
});
