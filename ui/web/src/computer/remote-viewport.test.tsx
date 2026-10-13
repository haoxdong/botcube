// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RemoteViewport } from './remote-viewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const input = vi.fn();
const render = async (interactive: boolean, expanded = true) => await act(() => root.render(
  <RemoteViewport interactive={interactive} expanded={expanded} sessionId="browser-1" completeTouch={(end) => end()}>
    <button onClick={input} onKeyDown={input}>Remote input</button>
  </RemoteViewport>,
));
beforeEach(() => {
  input.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it('blocks pointer and keyboard delivery while watching, including permission loss', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  await act(() => button.click());
  expect(input).toHaveBeenCalledTimes(1);
  button.focus();
  await render(false);
  await act(() => {
    button.click();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(input).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.remote-viewport-content')?.hasAttribute('inert')).toBe(true);
  expect(document.activeElement).not.toBe(button);
});

it('preserves ordinary interactive frame delivery outside the expanded computer', async () => {
  await render(true, false);
  await act(() => container.querySelector('button')?.click());
  expect(input).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.remote-viewport-shield')).toBeNull();
});

it('consumes a pinch before remote activation and preserves the following tap', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const delivered: string[] = [];
  for (const type of ['touchstart', 'touchmove', 'touchend']) button.addEventListener(type, () => delivered.push(type));
  const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
  const second = { identifier: 2, clientX: 150, clientY: 100, target: button } as unknown as Touch;
  const touch = async (type: string, touches: Touch[], changedTouches = touches) => await act(() => button.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches })));
  await touch('touchstart', [first]);
  await touch('touchstart', [first, second], [second]);
  await touch('touchmove', [first, second]);
  await touch('touchend', [first], [second]);
  await touch('touchmove', [first]);
  await touch('touchend', [], [first]);
  expect(delivered).toEqual([]);
  await touch('touchstart', [first]);
  await touch('touchend', [], [first]);
  expect(delivered).toEqual(['touchstart', 'touchend']);
});

it('releases a canceled remote touch', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const released = vi.fn();
  button.addEventListener('touchend', released);
  const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
  await act(() => {
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first] }));
    button.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [{ ...first, clientX: 120 }] }));
    button.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [], changedTouches: [first] }));
  });
  expect(released).toHaveBeenCalledTimes(1);
});

it('releases an active remote touch once when input permission ends', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const released = vi.fn();
  button.addEventListener('touchend', released);
  const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
  await act(() => {
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first] }));
    button.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [{ ...first, clientX: 120 }] }));
  });
  await render(false);
  expect(released).toHaveBeenCalledTimes(1);
});

for (const ending of ['cancel', 'permission'] as const) it(`drops a pending touch on ${ending} without activating remote input`, async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const delivered: string[] = [];
  for (const type of ['touchstart', 'touchmove', 'touchend']) button.addEventListener(type, () => delivered.push(type));
  const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
  await act(() => button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first] })));
  if (ending === 'permission') await render(false);
  else await act(() => button.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [], changedTouches: [first] })));
  expect(delivered).toEqual([]);
  await render(true);
  await act(() => {
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first] }));
    button.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [first] }));
  });
  expect(delivered).toEqual(['touchstart', 'touchend']);
});

it('delivers a one-finger drag before releasing it when a second finger arrives', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const delivered: string[] = [];
  for (const type of ['touchstart', 'touchmove', 'touchend']) button.addEventListener(type, () => delivered.push(type));
  const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
  const moved = { ...first, clientX: 120 };
  const second = { identifier: 2, clientX: 150, clientY: 100, target: button } as unknown as Touch;
  await act(() => {
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first], targetTouches: [first], changedTouches: [first] }));
    button.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [moved], targetTouches: [moved], changedTouches: [moved] }));
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [moved, second], targetTouches: [moved, second], changedTouches: [second] }));
  });
  expect(delivered).toEqual(['touchstart', 'touchmove', 'touchend']);
});

it('keeps a trackpad pinch on this device while plain scrolls reach the remote browser', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const wheels: boolean[] = [];
  button.addEventListener('wheel', (event) => wheels.push(event.ctrlKey));
  // happy-dom's WheelEvent takes no modifier keys.
  const wheel = (ctrlKey: boolean) => Object.defineProperty(new WheelEvent('wheel', { bubbles: true, cancelable: true }), 'ctrlKey', { value: ctrlKey });
  await act(() => {
    button.dispatchEvent(wheel(true));
    button.dispatchEvent(wheel(false));
  });
  expect(wheels).toEqual([false]);
});

it('delivers a finger held still to the remote browser before it lifts, for a long-press', async () => {
  vi.useFakeTimers();
  try {
    await render(true);
    const button = container.querySelector('button');
    if (button === null) throw new Error('Remote input is missing');
    const delivered: string[] = [];
    for (const type of ['touchstart', 'touchend']) button.addEventListener(type, () => delivered.push(type));
    const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
    await act(() => button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first], targetTouches: [first], changedTouches: [first] })));
    expect(delivered).toEqual([]);
    await act(() => vi.advanceTimersByTime(250));
    expect(delivered).toEqual(['touchstart']);
    await act(() => button.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [first] })));
    expect(delivered).toEqual(['touchstart', 'touchend']);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps mouse moves from the remote browser while two fingers zoom, as WebKit sends when the zoom moves the page under its cursor', async () => {
  await render(true);
  const button = container.querySelector('button');
  if (button === null) throw new Error('Remote input is missing');
  const moves = vi.fn();
  button.addEventListener('mousemove', moves);
  const first = { identifier: 1, clientX: 100, clientY: 100, target: button } as unknown as Touch;
  const second = { identifier: 2, clientX: 150, clientY: 100, target: button } as unknown as Touch;
  await act(() => {
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first], targetTouches: [first], changedTouches: [first] }));
    button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first, second], targetTouches: [first, second], changedTouches: [second] }));
    button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  expect(moves).not.toHaveBeenCalled();
  await act(() => button.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [first, second] })));
  await act(() => button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  expect(moves).toHaveBeenCalledTimes(1);
});
