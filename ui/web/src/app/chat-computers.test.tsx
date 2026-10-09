import { HttpAgent } from '@ag-ui/client';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ComputerViewProps } from '../cartridge/index.js';
import { ChatComputers } from './chat-computers';

const mounted: string[] = [];
const released: string[] = [];
function Computer({ conversation, activity }: ComputerViewProps) {
  useEffect(() => {
    mounted.push(conversation.id);
    return () => { released.push(conversation.id); };
  }, []);
  return <section aria-label={conversation.id}>
    <p>{activity.messages.map((message) => message.id).join(',')}</p>
    <button disabled={activity.stop === null} onClick={activity.stop ?? undefined}>Stop</button>
  </section>;
}
function chat(id: string, message = id) {
  return {
    conversation: { id, service: 'chat-service' as const },
    agent: new HttpAgent({ url: 'http://chat.test/agent', threadId: id, initialMessages: [{ id: message, role: 'user', content: message }] }),
  };
}
const stop = vi.fn();
const props = { agentId: 'test', View: Computer, agentName: 'Agent', stop };
beforeEach(() => { mounted.length = 0; released.length = 0; stop.mockClear(); });
afterEach(() => vi.useRealTimers());

it('retains two opened chats, evicts the oldest inactive chat, and never admits closed-profile navigation', () => {
  const main = chat('main'); const side = chat('side'); const third = chat('third');
  const view = render(<ChatComputers {...props} current={main} shown={false} />);
  expect(mounted).toEqual([]);
  view.rerender(<ChatComputers {...props} current={main} shown />);
  view.rerender(<ChatComputers {...props} current={side} shown />);
  view.rerender(<ChatComputers {...props} current={third} shown={false} />);
  expect(mounted).toEqual(['main', 'side']);
  expect(released).toEqual([]);
  view.rerender(<ChatComputers {...props} current={third} shown />);
  expect(mounted).toEqual(['main', 'side', 'third']);
  expect(released).toEqual(['main']);
  expect(screen.getByRole('region', { name: 'third' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'side' })).toBeNull();
});

it('expires hidden computers after a minute, including profile closure, and keeps the visible computer', async () => {
  vi.useFakeTimers();
  const main = chat('main'); const side = chat('side');
  const view = render(<ChatComputers {...props} current={main} shown />);
  view.rerender(<ChatComputers {...props} current={side} shown />);
  await act(() => vi.advanceTimersByTime(59_999));
  expect(released).toEqual([]);
  await act(() => vi.advanceTimersByTime(1));
  expect(released).toEqual(['main']);
  view.rerender(<ChatComputers {...props} current={side} shown={false} />);
  await act(() => vi.advanceTimersByTime(60_000));
  expect(released).toEqual(['main', 'side']);
  expect(mounted).toEqual(['main', 'side']);
});

it('rebinds a retained computer to the reopened chat agent and current Stop without recreating its view', async () => {
  const main = chat('main', 'original'); const side = chat('side'); const reopened = chat('main', 'replayed');
  const firstStop = vi.fn(); const latestStop = vi.fn();
  const view = render(<ChatComputers {...props} current={main} shown stop={firstStop} />);
  const original = screen.getByRole('region', { name: 'main' });
  view.rerender(<ChatComputers {...props} current={side} shown />);
  view.rerender(<ChatComputers {...props} current={reopened} shown stop={latestStop} />);
  expect(screen.getByRole('region', { name: 'main' })).toBe(original);
  expect(screen.getByText('replayed')).toBeVisible();
  act(() => main.agent.setMessages([{ id: 'obsolete', role: 'user', content: 'old' }]));
  expect(screen.queryByText('obsolete')).toBeNull();
  act(() => reopened.agent.setMessages([{ id: 'fresh', role: 'user', content: 'new' }]));
  expect(screen.getByText('fresh')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(latestStop).toHaveBeenCalledOnce();
  expect(firstStop).not.toHaveBeenCalled();
  expect(mounted).toEqual(['main', 'side']);
  view.unmount();
  expect(released.toSorted()).toEqual(['main', 'side']);
});
