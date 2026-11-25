import { FILE_ACCOUNT_LOCK } from './plugin/file-account.ts';

type OpeningResponse = { response: Response } | { error: unknown };

declare global {
  interface Window {
    __botcubeOpeningRequests?: Record<string, Promise<OpeningResponse> | undefined>;
  }
}

/** Start cookie-authenticated reads before hydration; consumers take each response once. */
export function startOpeningRequests(chatServiceUrl: string): void {
  const accountUrl = `${chatServiceUrl}/account/session`;
  const urls = [accountUrl, `${chatServiceUrl}/main-chat`]
    .filter(() => window.location.pathname === '/')
    .filter((url) => url === accountUrl || !new URLSearchParams(window.location.search).has('chat'));
  window.__botcubeOpeningRequests = Object.fromEntries(urls.map((url) => {
    const send = () => fetch(url, { credentials: 'include', cache: 'no-store' });
    const request = url === accountUrl ? navigator.locks.request(FILE_ACCOUNT_LOCK, send) : send();
    return [url, request.then((response) => ({ response }), (error: unknown) => ({ error }))];
  }));
}

export function peekOpeningResponse(url: string): Promise<OpeningResponse> | null {
  if (typeof window === 'undefined') return null;
  const pending = window.__botcubeOpeningRequests?.[url];
  if (pending === undefined) return null;
  return pending.then((result) => {
    return 'error' in result ? result : { response: result.response.clone() };
  });
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
