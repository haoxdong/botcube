import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, onTestFinished, vi } from 'vitest';

import { HeaderName, useHeaderWorking } from './chat-header';
import { Fades } from './motion';

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
  view.rerender(<HeaderName name="Marq" working={false} />);
  expect(screen.getByText('is working')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('is working')).toBeNull(), { timeout: 1000 });
});

it('shows the current agent name while its working status changes', () => {
  const view = render(<HeaderName name="Marq" working={false} />);
  view.rerender(<HeaderName name="Archibald" working />);
  expect(view.container.querySelector('.chat-header-label')).toHaveTextContent('Archibaldis working');
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

it('keeps the header usable inside the application presence owner', () => {
  tokens();
  const view = render(<Fades><HeaderName name="Marq" working /></Fades>);
  expect(view.getByText('is working')).toBeInTheDocument();
});
