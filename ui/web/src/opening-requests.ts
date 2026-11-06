type OpeningResponse = { response: Response } | { error: unknown };

declare global {
  interface Window {
    __botcubeOpeningRequests?: Record<string, Promise<OpeningResponse> | undefined>;
  }
}

/** Start cookie-authenticated reads before hydration; consumers take each response once. */
export function startOpeningRequests(chatServiceUrl: string): void {
  const urls = [`${chatServiceUrl}/account/session`, `${chatServiceUrl}/main-chat`]
    .filter(() => window.location.pathname === '/')
    .filter((url) => !url.endsWith('/main-chat') || !new URLSearchParams(window.location.search).has('chat'));
  window.__botcubeOpeningRequests = Object.fromEntries(urls.map((url) => [url, fetch(url, { credentials: 'include', cache: 'no-store' })
    .then((response) => ({ response }), (error: unknown) => ({ error }))]));
}

export function takeOpeningResponse(url: string): Promise<Response> | null {
  if (typeof window === 'undefined') return null;
  const pending = window.__botcubeOpeningRequests?.[url];
  if (pending === undefined) return null;
  discardOpeningResponse(url);
  return pending.then((result) => {
    if ('error' in result) throw result.error;
    return result.response;
  });
}

export function discardOpeningResponse(url: string): void {
  if (typeof window !== 'undefined') delete window.__botcubeOpeningRequests?.[url];
}
