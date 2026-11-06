import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpAgent } from '@ag-ui/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSteering } from './steering';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ accepted: true })));
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, run: () => unknown) => run() } });
});

function setup() {
  const agent = new HttpAgent({ url: 'http://chat.test' });
  const submit = vi.fn(() => true);
  const failed = vi.fn();
  const hook = renderHook(({ running, ready }) => useSteering({ agent, accountId: 'account', threadId: 'thread', running, ready, serviceUrl: 'http://chat.test', submit, failed, heldElsewhere: vi.fn() }), { initialProps: { running: true, ready: true } });
  return { agent, submit, failed, ...hook };
}

it('sends during a Turn and keeps each message until its ID lands inline', async () => {
  const { result, agent, submit } = setup();
  act(() => { result.current.steer('Use another date'); });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const call = vi.mocked(fetch).mock.calls[0];
  const body = call?.[1]?.body;
  if (typeof body !== 'string') throw new Error('No steering payload');
  const message = JSON.parse(body);
  expect(call?.[0]).toBe('http://chat.test/threads/thread/steer');
  expect(message.content).toBe('Use another date');
  expect(localStorage.getItem('botcube.steering:account:thread')).toContain('Use another date');
  act(() => agent.setMessages([{ ...message, role: 'user' }]));
  await waitFor(() => expect(localStorage.getItem('botcube.steering:account:thread')).toBeNull());
  expect(submit).not.toHaveBeenCalled();
});

it('drops unconsumed messages so none starts the next Turn', async () => {
  const { result, rerender, submit } = setup();
  act(() => { result.current.steer('Stopped before it was taken'); });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  act(() => { result.current.drop(); });
  rerender({ running: false, ready: true });
  await act(async () => {});
  expect(submit).not.toHaveBeenCalled();
  expect(localStorage.getItem('botcube.steering:account:thread')).toBeNull();
});

it('does not deliver a message queued behind an in-flight one once dropped', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(fetch).mockImplementationOnce(async () => { await held; return Response.json({ accepted: true }); });
  const { result } = setup();
  act(() => { result.current.steer('First instruction'); });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  act(() => { result.current.steer('Second instruction'); });
  await waitFor(() => expect(localStorage.getItem('botcube.steering:account:thread')).toContain('Second instruction'));
  act(() => { result.current.drop(); });
  await act(async () => { release(); });
  await act(async () => {});
  expect(fetch).toHaveBeenCalledOnce();
});

it('retains failed steering for the next Turn and reports the failure', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
  const { result, failed } = setup();
  act(() => { result.current.steer('Keep my message'); });
  await waitFor(() => expect(failed).toHaveBeenCalledWith('Steering failed: HTTP 503. Your message is kept for the next Turn.'));
  expect(localStorage.getItem('botcube.steering:account:thread')).toContain('Keep my message');
});

it('retries a pending fallback when models or the network become ready', async () => {
  const { result, rerender, submit } = setup();
  act(() => { result.current.steer('Wait for readiness'); });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  rerender({ running: false, ready: false });
  await act(async () => {});
  expect(submit).not.toHaveBeenCalled();
  rerender({ running: false, ready: true });
  await waitFor(() => expect(submit).toHaveBeenCalledWith('Wait for readiness'));
});

it('sends all unconsumed messages in the next Turn', async () => {
  const { result, rerender, submit } = setup();
  act(() => { result.current.steer('First change'); result.current.steer('Second change'); });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  rerender({ running: false, ready: true });
  await waitFor(() => expect(submit).toHaveBeenCalledWith('First change\n\nSecond change'));
  expect(JSON.parse(localStorage.getItem('botcube.steering:account:thread') ?? '[]')).toEqual([]);
});

it('delivers successive steering messages in order outside the storage lock', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(fetch).mockImplementationOnce(async () => { await held; return Response.json({ accepted: true }); });
  const { result } = setup();
  act(() => { result.current.steer('First instruction'); });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  act(() => { result.current.steer('Second instruction'); });
  await waitFor(() => expect(localStorage.getItem('botcube.steering:account:thread')).toContain('Second instruction'));
  expect(fetch).toHaveBeenCalledOnce();
  release();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});
