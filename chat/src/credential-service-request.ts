import { HttpError } from './http-error.js';

export function fetchCredentialService(
  url: string,
  { token, accountId, sessionId }: { token: string; accountId: string; sessionId: string },
  init: Pick<RequestInit, 'method' | 'body'> = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'x-botcube-account-id': accountId,
      'x-botcube-session-id': sessionId,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new HttpError(503, `Credential Service request failed: ${String(error)}`);
  });
}
