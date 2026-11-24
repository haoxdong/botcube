// The viewport: one phone breakpoint at 640px, and a touch screen wider than that is a tablet.
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { useViewport } from './viewport';

// A screen `width` px wide that is touched (an iPad) or pointed at (a desktop); its queries are answered as a browser
// would, and `resize` moves it and tells the listeners.
function screen(width: number, touch: boolean) {
  const listeners = new Set<() => void>();
  const answer = (query: string) => query.split(' and ').every((part) => {
    const [, edge, px] = /^\((max|min)-width: (\d+)px\)$/.exec(part) ?? [];
    if (edge) return edge === 'max' ? width <= Number(px) : width >= Number(px);
    if (part === '(hover: none)' || part === '(pointer: coarse)') return touch;
    throw new Error(`An unexpected query: ${part}`);
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return answer(query); },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return (to: number) => act(() => {
    width = to;
    for (const listener of listeners) listener();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  [390, false, 'phone'], [640, true, 'phone'], [641, false, 'desktop'], [744, true, 'tablet'], [767, false, 'desktop'], [1440, false, 'desktop'],
] as const)('calls a %i px screen (touch %s) a %s', (width, touch, expected) => {
  screen(width, touch);
  expect(renderHook(() => useViewport()).result.current).toBe(expected);
});

it('follows a rotation across the breakpoint', () => {
  const resize = screen(744, true);
  const { result } = renderHook(() => useViewport());
  resize(390);
  expect(result.current).toBe('phone');
  resize(744);
  expect(result.current).toBe('tablet');
});
