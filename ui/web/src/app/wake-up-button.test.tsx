import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WakeUpButton } from './wake-up-button';
import { WAKE_POLL_MS } from './wake-up';

const since = '2026-11-04T05:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function waking(lapses = false) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(Date.parse(since));
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    const first = !asked.includes(path);
    asked.push(path);
    return path === '/production/wake' ? Response.json(lapses && !first ? { state: 'parked' } : { state: 'waking', since }) : Response.json({ status: 'parked' }, { status: 503 });
  }));
  return asked;
}

it('counts the unpark down as it polls', async () => {
  waking();
  render(<WakeUpButton title="Marq" chatServiceUrl="http://chat.test" />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole('status')).toHaveTextContent('Waking up, about 12 minutes');

  await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));

  expect(screen.getByRole('status')).toHaveTextContent('Waking up, about 8 minutes');
});

it('stops polling once it is gone', async () => {
  const asked = waking();
  const { unmount } = render(<WakeUpButton title="Marq" chatServiceUrl="http://chat.test" />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole('status')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(WAKE_POLL_MS));
  unmount();
  const before = asked.length;

  await act(() => vi.advanceTimersByTimeAsync(10 * WAKE_POLL_MS));

  expect(asked.slice(before)).toEqual([]);
});

it('says the wake failed when production parks again', async () => {
  waking(true);
  render(<WakeUpButton title="Marq" chatServiceUrl="http://chat.test" />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole('status')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(WAKE_POLL_MS));

  expect(screen.getByText("Couldn't wake Marq: the wake did not start")).toBeInTheDocument();
});
