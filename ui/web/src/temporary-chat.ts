export interface TemporaryChat {
  readonly sessionId: string;
  readonly token: string;
}

export function temporaryChatFetch(chatServiceUrl: string, chat: TemporaryChat, fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const allowed = new Set([new URL(chatServiceUrl).href, new URL(`${chatServiceUrl}/threads/${chat.sessionId}/stop`).href]);
  return (url: string, init: RequestInit) => {
    if (!allowed.has(new URL(url).href)) throw new Error('Temporary chat capability cannot be sent to this endpoint');
    const headers = new Headers(init.headers);
    headers.set('x-botcube-temporary-chat', chat.token);
    return fetchImpl(url, { ...init, headers, credentials: 'omit', redirect: 'error' });
  };
}
