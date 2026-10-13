const DEFAULT_CHAT_SERVICE_URL = 'http://localhost:8123';

function getChatServiceUrl(): string {
  return process.env.NEXT_PUBLIC_CHAT_SERVICE_URL ?? DEFAULT_CHAT_SERVICE_URL;
}

export function buildBrowserLiveViewUrl(
  sessionId: string,
  chatServiceUrl: string = getChatServiceUrl(),
): string {
  const url = new URL('/browser-live-view-url', chatServiceUrl);
  url.searchParams.set('session_id', sessionId);
  return url.toString();
}

export async function fetchBrowserLiveViewSignedUrl(
  sessionId: string,
  {
    chatServiceUrl = getChatServiceUrl(),
    fetchImpl = fetch,
    signal = null,
  }: { chatServiceUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal | null } = {},
): Promise<string> {
  // Send account cookies: auth-browser (site sign-in) sessions are signed only
  // for the owning account's trusted session.
  const response = await fetchImpl(buildBrowserLiveViewUrl(sessionId, chatServiceUrl), {
    cache: 'no-store',
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Live view URL request failed with ${response.status}`);
  }
  const payload = await response.json() as { signedUrl?: unknown };
  if (typeof payload.signedUrl !== 'string' || payload.signedUrl.length === 0) {
    throw new Error('Live view URL response did not include signedUrl');
  }
  return payload.signedUrl;
}
