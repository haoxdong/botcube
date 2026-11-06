import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, onTestFinished, vi } from 'vitest';

import { HeaderName, useHeaderWorking } from './header-status';

const tokens = () => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-move: 300ms; --motion-quick: 150ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
  onTestFinished(() => sheet.remove());
};

it('says nothing while the agent rests, and "is working" while a Turn runs', () => {
  const view = render(<HeaderName name="Marq" working={false} />);
  expect(view.container.querySelector('.chat-header-name')).toHaveTextContent(/^Marq$/);
  view.rerender(<HeaderName name="Marq" working />);
  expect(view.container.querySelector('.chat-header-status')).toHaveTextContent(/^is working$/);
});

it('lets "is working" fade as the Turn ends before it leaves the capsule', async () => {
  tokens();
  const view = render(<HeaderName name="Marq" working />);
  await act(() => import("./motion-features"));
  view.rerender(<HeaderName name="Marq" working={false} />);
  expect(screen.getByText('is working')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('is working')).toBeNull(), { timeout: 1000 });
});

/**
 * happy-dom lays nothing out: the capsule measures as WebKit drew Marq's, 61 by 23 at rest and 89 by 42 with "is
 * working", 30px wider for a longer name. Returns each element's settles as their scale keyframes.
 */
function measured() {
  const size = (rest: number, working: number, longer: number) =>
    function (this: HTMLElement) {
      if (!this.classList.contains('chat-header-name')) return 0;
      return (this.querySelector('.chat-header-status') ? working : rest) + (this.textContent.startsWith('Marq') ? 0 : longer);
    };
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(size(61, 89, 30));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(size(23, 42, 0));
  const animate = vi.spyOn(Element.prototype, 'animate');
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return (element: Element | null) =>
    animate.mock.calls
      .filter((_, call) => animate.mock.contexts[call] === element)
      .map(([keyframes]) => (Array.isArray(keyframes) ? keyframes : []).flatMap(({ transform }) => (typeof transform === 'string' && transform.startsWith('scale') ? [transform.match(/[\d.]+/g)?.map(Number) ?? []] : [])))
      .filter((scales) => scales.length > 0);
}

it('grows the capsule around "is working" by a transform alone, which keeps moving while a Turn start busies the page', async () => {
  tokens();
  const settles = measured();
  const view = render(<HeaderName name="Marq" working={false} />);
  view.rerender(<HeaderName name="Marq" working />);

  await waitFor(() => expect(settles(view.container.querySelector('.chat-header-name'))).toHaveLength(1));
  const [box] = settles(view.container.querySelector('.chat-header-name'));
  const [content] = settles(view.container.querySelector('.chat-header-label'));
  expect(box?.[0]?.[0]).toBeCloseTo(0.685, 3);
  expect(box?.[0]?.[1]).toBeCloseTo(0.548, 3);
  expect(box?.at(-1)).toEqual([1, 1]);
  expect(content?.[0]?.[0]).toBeCloseTo(1.459, 3);
  expect(content?.[0]?.[1]).toBeCloseTo(1.826, 3);
  expect(content?.at(-1)).toEqual([1, 1]);
});

it('keeps the grow until --motion-move after its first frame, however long the task that began it runs', async () => {
  tokens();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  measured();
  const cancel = vi.fn();
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => ({ cancel }) as unknown as Animation);
  // No frame draws until the test says so, as none does while a Turn start's long task runs.
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
  const view = render(<HeaderName name="Marq" working={false} />);
  await act(async () => {
    view.rerender(<HeaderName name="Marq" working />);
  });

  // The task that began the grow runs on for a second: the scale, not yet shown, keeps going.
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(cancel).not.toHaveBeenCalled();
  // Its first frame draws, and it ends --motion-move later.
  act(() => {
    for (const frame of frames.splice(0)) frame(1000);
    vi.advanceTimersByTime(299);
  });
  expect(cancel).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('shrinks the capsule from its working size once "is working" has faded', async () => {
  tokens();
  const settles = measured();
  const view = render(<HeaderName name="Marq" working />);
  // The line fades out only once Motion's features have loaded.
  await act(() => import('./motion-features'));
  view.rerender(<HeaderName name="Marq" working={false} />);
  await waitFor(() => expect(settles(view.container.querySelector('.chat-header-name'))).toHaveLength(1), { timeout: 1000 });

  const [box] = settles(view.container.querySelector('.chat-header-name'));
  expect(box?.[0]?.[0]).toBeCloseTo(1.459, 3);
  expect(box?.[0]?.[1]).toBeCloseTo(1.826, 3);
  expect(box?.at(-1)).toEqual([1, 1]);
});

it("grows from the name's own size after the agent's name changes", async () => {
  tokens();
  const settles = measured();
  const view = render(<HeaderName name="Marq" working={false} />);
  view.rerender(<HeaderName name="Archibald" working={false} />);
  await waitFor(() => expect(settles(view.container.querySelector('.chat-header-name'))).toHaveLength(1));
  view.rerender(<HeaderName name="Archibald" working />);

  // The name's own change settles first (61 → 91 wide), then "is working" grows from 91 by 23 to 119 by 42.
  await waitFor(() => expect(settles(view.container.querySelector('.chat-header-name'))).toHaveLength(2));
  const box = settles(view.container.querySelector('.chat-header-name'));
  expect(box.at(-1)?.[0]?.[0]).toBeCloseTo(0.765, 3);
  expect(box.at(-1)?.[0]?.[1]).toBeCloseTo(0.548, 3);
});

it('changes the capsule at once under Reduce Motion, where --motion-move is 0s', async () => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-move: 0s; --motion-quick: 150ms; }';
  onTestFinished(() => sheet.remove());
  const settles = measured();
  const view = render(<HeaderName name="Marq" working={false} />);
  view.rerender(<HeaderName name="Marq" working />);
  await Promise.resolve();

  expect(settles(view.container.querySelector('.chat-header-name'))).toEqual([]);
});

it('keeps the agent working through the gap between back-to-back Turns, and rests once none follows', () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const view = renderHook(({ chat, working }) => useHeaderWorking(chat, working), { initialProps: { chat: 'a', working: true } });
  view.rerender({ chat: 'a', working: false });
  act(() => {
    vi.advanceTimersByTime(60);
  });
  expect(view.result.current).toBe(true);
  view.rerender({ chat: 'a', working: true });
  view.rerender({ chat: 'a', working: false });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(view.result.current).toBe(false);
});

it('shows a resting chat at rest at once, though the chat left a moment ago was working', () => {
  const initialProps: { chat: string | null; working: boolean } = { chat: 'a', working: true };
  const view = renderHook(({ chat, working }) => useHeaderWorking(chat, working), { initialProps });
  view.rerender({ chat: 'b', working: false });
  expect(view.result.current).toBe(false);
  view.rerender({ chat: null, working: false });
  expect(view.result.current).toBe(false);
});
