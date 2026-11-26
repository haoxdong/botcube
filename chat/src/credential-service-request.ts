import { HttpError } from './http-error.js';

export interface SignedInvocation {
  token: string;
  accountId: string;
  sessionId: string;
}

export async function credentialServiceRequest(
  url: string,
  { token, accountId, sessionId }: SignedInvocation,
  step: string,
  read: 'json' | 'success-json' | 'status',
  init?: Pick<RequestInit, 'method' | 'body'>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, {
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

  const { ok, status } = response;
  if (read === 'status' || (read === 'success-json' && !ok)) {
    await response.body?.cancel().catch(() => {});
    return { ok, status, body: undefined };
  }

  const body: unknown = await response.json().catch(() => {
    throw new HttpError(503, `${step} returned HTTP ${status} with an unreadable JSON body`);
  });
  return { ok, status, body };
}
