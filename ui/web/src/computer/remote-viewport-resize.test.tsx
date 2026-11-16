import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, expect, it, vi } from 'vitest';

const gesture = vi.hoisted(() => {
  vi.stubEnv('NEXT_PUBLIC_REMOTE_VIEWPORT_CLAMP', '0');
  return { pinch: (_state: { first: boolean; offset: [number, number]; origin: [number, number]; memo: undefined }): unknown => { throw new Error('Pinch handler has not mounted'); } };
});
vi.mock('@use-gesture/react', () => ({ usePinch: (handler: typeof gesture.pinch) => { gesture.pinch = handler; } }));
import { RemoteViewport } from './remote-viewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => vi.unstubAllEnvs());

it('retains zoom on resize even when the retired flag is set to zero', async () => {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<RemoteViewport expanded interactive sessionId="browser" completeTouch={(end) => end()}><button>Remote input</button></RemoteViewport>));
    const host = container.querySelector('.remote-viewport');
    const target = container.querySelector('button');
    if (!host || !target) throw new Error('Remote viewport is missing');
    await act(() => { gesture.pinch({ first: true, offset: [2, 0], origin: [100, 100], memo: undefined }); });
    const scale = host.getAttribute('data-scale');
    expect(Number(scale)).toBeGreaterThan(1);
    await act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(host.getAttribute('data-scale')).toBe(scale);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
