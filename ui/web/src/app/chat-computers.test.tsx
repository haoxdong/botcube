import { HttpAgent } from '@ag-ui/client';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ComputerViewProps } from '../cartridge/index.js';
import { ChatComputers } from './chat-computers';

const mounted: string[] = [];
const released: string[] = [];
const connections = new Map<string, NonNullable<ComputerViewProps['onConnectionChange']>>();
const activities = new Map<string, ComputerViewProps['activity']>();
let connects = true;
function Computer({ conversation, activity, onConnectionChange }: ComputerViewProps) {
  if (onConnectionChange) connections.set(conversation.id, onConnectionChange);
  activities.set(conversation.id, activity);
  useEffect(() => {
    mounted.push(conversation.id);
    if (connects) onConnectionChange?.(true);
    return () => { released.push(conversation.id); };
  }, []);
  useEffect(() => activity.subscribeToCustomEvents(() => {}), [activity.subscribeToCustomEvents]);
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
function connection(id: string) {
  const callback = connections.get(id);
  if (!callback) throw new Error(`No connection callback for ${id}`);
  return callback;
}
const stop = vi.fn();
const props = { agentId: 'test', View: Computer, agentName: 'Agent', stop };
beforeEach(() => {
  mounted.length = 0; released.length = 0; stop.mockClear(); connections.clear(); activities.clear(); connects = true;
});
afterEach(() => vi.useRealTimers());

it('retains connected computers beyond a minute and a third opened chat, including profile closure', async () => {
  vi.useFakeTimers();
  const main = chat('main'); const side = chat('side'); const third = chat('third');
  const view = render(<ChatComputers {...props} current={main} shown={false} />);
  expect(mounted).toEqual([]);
  view.rerender(<ChatComputers {...props} current={main} shown />);
  const original = screen.getByRole('region', { name: 'main' });
  view.rerender(<ChatComputers {...props} current={side} shown />);
  await act(() => vi.advanceTimersByTime(61_000));
  view.rerender(<ChatComputers {...props} current={third} shown />);
  view.rerender(<ChatComputers {...props} current={third} shown={false} />);
  await act(() => vi.advanceTimersByTime(61_000));
  view.rerender(<ChatComputers {...props} current={main} shown />);
  expect(screen.getByRole('region', { name: 'main' })).toBe(original);
  expect(mounted).toEqual(['main', 'side', 'third']);
  expect(released).toEqual([]);
});

it('retires hidden disconnected hosts and ignores a notification from a replaced entry', () => {
  const main = chat('main'); const side = chat('side');
  const view = render(<ChatComputers {...props} current={main} shown />);
  const original = screen.getByRole('region', { name: 'main' });
  const oldConnection = connection('main');
  view.rerender(<ChatComputers {...props} current={side} shown />);
  act(() => oldConnection(false));
  expect(original.isConnected).toBe(false);
  expect(released).toEqual(['main']);
  view.rerender(<ChatComputers {...props} current={main} shown />);
  const replacement = screen.getByRole('region', { name: 'main' });
  view.rerender(<ChatComputers {...props} current={side} shown />);
  act(() => oldConnection(false));
  expect(replacement.isConnected).toBe(true);
  view.rerender(<ChatComputers {...props} current={main} shown />);
  expect(screen.getByRole('region', { name: 'main' })).toBe(replacement);
  expect(mounted).toEqual(['main', 'side', 'main']);
});

it('keeps a selected disconnected host and removes it when hidden without another notification', () => {
  const main = chat('main'); const side = chat('side');
  const view = render(<ChatComputers {...props} current={main} shown />);
  const original = screen.getByRole('region', { name: 'main' });
  act(() => connection('main')(false));
  expect(original.isConnected).toBe(true);
  view.rerender(<ChatComputers {...props} current={side} shown />);
  expect(original.isConnected).toBe(false);
  expect(screen.getByRole('region', { name: 'side' })).toBeVisible();
});

it('does not retain a pending computer or a view without connection reporting', () => {
  connects = false;
  const main = chat('main'); const side = chat('side'); const third = chat('third');
  const view = render(<ChatComputers {...props} current={main} shown />);
  const original = screen.getByRole('region', { name: 'main' });
  view.rerender(<ChatComputers {...props} current={side} shown />);
  expect(original.isConnected).toBe(false);
  view.rerender(<ChatComputers {...props} current={third} shown />);
  expect(mounted).toEqual(['main', 'side', 'third']);
  expect(released).toEqual(['main', 'side']);
  expect(screen.getByRole('region', { name: 'third' })).toBeVisible();
});

it('drops hidden activity and subscriptions, then rebinds current messages and Stop without recreating the view', async () => {
  const main = chat('main', 'original'); const side = chat('side'); const reopened = chat('main', 'replayed');
  const unsubscribe = vi.fn();
  const subscribe = main.agent.subscribe.bind(main.agent);
  vi.spyOn(main.agent, 'subscribe').mockImplementation((subscriber) => {
    const subscription = subscribe(subscriber);
    return { unsubscribe: () => { unsubscribe(); subscription.unsubscribe(); } };
  });
  const firstStop = vi.fn(); const latestStop = vi.fn();
  const view = render(<ChatComputers {...props} current={main} shown stop={firstStop} />);
  const original = screen.getByRole('region', { name: 'main' });
  main.agent.isRunning = true;
  view.rerender(<ChatComputers {...props} current={side} shown />);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(activities.get('main')).toEqual({ messages: [], running: false, stop: null, subscribeToCustomEvents: expect.any(Function) });
  act(() => main.agent.setMessages([{ id: 'obsolete', role: 'user', content: 'old' }]));
  expect(original.textContent).toBe('Stop');
  view.rerender(<ChatComputers {...props} current={reopened} shown stop={latestStop} />);
  expect(screen.getByRole('region', { name: 'main' })).toBe(original);
  expect(screen.getByText('replayed')).toBeVisible();
  act(() => reopened.agent.setMessages([{ id: 'fresh', role: 'user', content: 'new' }]));
  expect(screen.getByText('fresh')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(latestStop).toHaveBeenCalledOnce();
  expect(firstStop).not.toHaveBeenCalled();
  expect(mounted).toEqual(['main', 'side']);
  view.unmount();
  expect(released.toSorted()).toEqual(['main', 'side']);
});
