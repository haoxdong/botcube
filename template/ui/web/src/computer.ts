/** The Agent Computer of one chat, as the template Chat Service reports it. */
export type Computer =
  | { state: 'asleep' }
  | { state: 'awake'; browserSessionId: string };

/** The chat has no Session yet: its first message starts the computer. */
export class ChatNotStarted extends Error {}

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

function computer(payload: unknown): Computer {
  if (typeof payload === 'object' && payload !== null && 'state' in payload) {
    if (payload.state === 'asleep') return { state: 'asleep' };
    if (payload.state === 'awake' && 'browserSessionId' in payload && typeof payload.browserSessionId === 'string') {
      return { state: 'awake', browserSessionId: payload.browserSessionId };
    }
  }
  throw new Error('The Agent Computer answered with an unknown state');
}

async function request(chatServiceUrl: string, threadId: string, wake: boolean) {
  const action = wake ? 'wake the Agent Computer' : 'load the Agent Computer';
  const response = await fetch(`${chatServiceUrl}/agent-computer${wake ? '/wake' : ''}?${new URLSearchParams({ thread_id: threadId })}`, {
    method: wake ? 'POST' : 'GET',
    credentials: 'include',
    cache: 'no-store',
  });
  if (response.status === 404) throw new ChatNotStarted("The computer starts with this chat's first message.");
  if (!response.ok) throw await failure(response, action);
  return computer(await response.json());
}

export const loadComputer = (chatServiceUrl: string, threadId: string) => request(chatServiceUrl, threadId, false);
export const wakeComputer = (chatServiceUrl: string, threadId: string) => request(chatServiceUrl, threadId, true);

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
