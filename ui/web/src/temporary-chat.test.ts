import { expect, it, vi } from 'vitest';
import { temporaryChatFetch } from './temporary-chat';

it('refuses to send a temporary capability outside its Turn and Stop endpoints', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  const request = temporaryChatFetch('https://chat.example', { sessionId: 'chat-1', token: 'temporary-only' }, fetchImpl);
  for (const url of ['https://other.example', 'https://chat.example/agent/memory', 'https://chat.example/threads/other-chat/stop']) {
    expect(() => request(url, {})).toThrow('Temporary chat capability cannot be sent to this endpoint');
  }
  expect(fetchImpl).not.toHaveBeenCalled();
  await request('https://chat.example/threads/chat-1/stop', { credentials: 'include', redirect: 'follow' });
  expect(fetchImpl).toHaveBeenCalledWith('https://chat.example/threads/chat-1/stop', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
});
