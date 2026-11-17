/** The computer went to sleep: its image is gone until it wakes again. */
export class ComputerAsleep extends Error {}

async function failure(response: Response, action: string) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A body that is not JSON carries no reason; the status below does, and the failure still throws.
  }
  const reason = typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string' ? `: ${body.detail}` : '';
  return new Error(`Could not ${action} (HTTP ${response.status})${reason}`);
}

/** The image URL of the chat's awake computer. */
export const screenUrl = (chatServiceUrl: string, threadId: string) =>
  `${chatServiceUrl}/agent-computer/view?${new URLSearchParams({ thread_id: threadId })}`;

/** The owner's image URL for one browser Session, as a pop-out window finds it. */
export async function liveViewUrl(chatServiceUrl: string, sessionId: string) {
  const response = await fetch(`${chatServiceUrl}/browser-live-view-url?${new URLSearchParams({ session_id: sessionId })}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw await failure(response, 'open the live view');
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('signedUrl' in payload) || typeof payload.signedUrl !== 'string') {
    throw new Error('The live view answered with no URL');
  }
  return payload.signedUrl;
}

/** One frame of the computer's screen, as an object URL the caller revokes. */
export async function screenFrame(url: string, signal: AbortSignal) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (response.status === 409) throw new ComputerAsleep('The computer went to sleep.');
  if (!response.ok) throw await failure(response, 'show the screen');
  return URL.createObjectURL(await response.blob());
}

/** The pop-out window's address for one browser Session. */
const popOutUrl = (sessionId: string) => `/browser-view?${new URLSearchParams({ session_id: sessionId })}`;

/** Opens one browser Session's screen in its own window. */
export const popOut = (sessionId: string) => window.open(popOutUrl(sessionId), '_blank', 'popup,width=1280,height=840');
