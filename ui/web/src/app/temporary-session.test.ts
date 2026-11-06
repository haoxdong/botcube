import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useTemporarySession } from './temporary-session';

const requests: { url: string; init: RequestInit | undefined }[] = [];
let temporaryChats: () => Response;

beforeEach(() => {
  vi.restoreAllMocks();
  requests.length = 0;
  temporaryChats = () => Response.json({ sessionId: 'temporary-1', token: 'temporary-token' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return url === 'http://chat.test/temporary-chats' ? temporaryChats() : new Response(null, { status: 500 });
  }));
});

const render = (enabled = true) => renderHook(() => useTemporarySession({ enabled, chatServiceUrl: 'http://chat.test', agentId: 'research-agent' }));

it('starts a temporary chat without the account cookie and sends its Turns to the service root with its capability', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = render();
  await waitFor(() => expect(result.current.current.id).toBe('temporary-1'));
  expect(result.current.mainChatId).toBe('temporary-1');
  expect(result.current.current.showWelcome).toBe(true);

  result.current.current.agent.addMessage({ id: 'question', role: 'user', content: 'Hello' });
  await result.current.current.agent.runAgent().catch(() => undefined);

  expect(requests.map(({ url, init }) => [init?.method, url])).toEqual([
    ['POST', 'http://chat.test/temporary-chats'],
    ['POST', 'http://chat.test'],
  ]);
  const [started, turn] = requests;
  expect(started?.init?.credentials).toBe('omit');
  expect(turn?.init?.credentials).toBe('omit');
  expect(new Headers(turn?.init?.headers).get('x-botcube-temporary-chat')).toBe('temporary-token');
  expect(JSON.parse(turn?.init?.body as string)).toMatchObject({ threadId: 'temporary-1', messages: [{ id: 'question', content: 'Hello' }] });
});

it('says why a temporary chat could not start', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  temporaryChats = () => new Response(null, { status: 503 });
  const { result } = render();

  await waitFor(() => expect(result.current.failures.mainChat).toBe('Your chat could not be started: Failed to start a temporary chat: 503'));
  expect(result.current.current.id).toBeNull();
});

it('starts nothing for a visitor who is not temporary', async () => {
  render(false);
  await new Promise((done) => setTimeout(done, 0));

  expect(requests).toEqual([]);
});
