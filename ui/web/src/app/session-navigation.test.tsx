import { act, cleanup, renderHook, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionNavigation } from './session-navigation';
import { startOpeningRequests } from '../opening-requests';
import { keepMainChatCopy } from './main-chat-copy';
import recording from '../../test/reload-mid-turn';
import type { MainChatCopy } from './main-chat-copy';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])('keeps the running reply through cached Main Chat hand-over on reload (mounted copy %s)', async (mounted) => {
  vi.useFakeTimers();
  const cached: MainChatCopy = { id: 'main-layout', messages: recording.cached };
  keepMainChatCopy('acct-layout', cached);
  let ready = false;
  let transcript: MainChatCopy = { id: cached.id, ...recording.running };
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.endsWith('/main-chat') ? transcript : { threads: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  startOpeningRequests('http://chat.test');
  await Promise.resolve();
  const { result, rerender } = renderHook(() => useSessionNavigation({
    ready, accountId: 'acct-layout', chatServiceUrl: 'http://chat.test',
    agentId: 'research-agent', opening: mounted ? { accountId: 'acct-layout', copy: cached } : null, reading: false,
  }));
  await act(async () => { await result.current.openMainChat(); });
  expect(result.current.current.agent.messages).toEqual(recording.running.messages);
  expect(result.current.current.turnRunsOnServer).toBe(true);
  ready = true;
  rerender();
  await act(async () => {});
  transcript = { id: cached.id, ...recording.completed };
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

  expect(result.current.current.agent.messages).toEqual(recording.completed.messages);
  expect(result.current.current.turnRunsOnServer).toBe(false);
});

it('retains loaded running transcript when the live chat suspends during reload', async () => {
  vi.useFakeTimers();
  const cached: MainChatCopy = { id: 'main-layout', messages: recording.cached };
  const opening = { accountId: 'acct-layout', copy: cached };
  keepMainChatCopy(opening.accountId, cached);
  let transcript: MainChatCopy = { id: cached.id, ...recording.running };
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(
    url.endsWith('/main-chat') ? transcript : { threads: [] },
  )));
  let suspended: Promise<void> | null = null;
  const { result, rerender } = renderHook(() => {
    const navigation = useSessionNavigation({
      ready: true, accountId: opening.accountId, chatServiceUrl: 'http://chat.test',
      agentId: 'research-agent', opening, reading: false,
    });
    if (suspended !== null) throw suspended;
    return navigation;
  }, { wrapper: ({ children }) => <Suspense fallback={<p>Loading live chat</p>}>{children}</Suspense> });
  await act(async () => {});
  expect(result.current.current.agent.messages).toEqual(recording.running.messages);
  const shown = result.current.current.agent;
  let resume = () => {};
  suspended = new Promise<void>((resolve) => { resume = resolve; });
  rerender();
  expect(screen.getByText('Loading live chat')).toBeVisible();
  suspended = null;
  await act(async () => { resume(); });
  expect(result.current.current.agent).toBe(shown);
  expect(result.current.current.agent.messages).toEqual(recording.running.messages);
  expect(result.current.current.turnRunsOnServer).toBe(true);
  transcript = { id: cached.id, ...recording.completed };
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(result.current.current.agent.messages).toEqual(recording.completed.messages);
  expect(result.current.current.turnRunsOnServer).toBe(false);
});
