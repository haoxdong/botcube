import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_SECONDS = 10 * 60;

/** Python's `json.dumps(..., sort_keys=True, separators=(',', ':'))`, ASCII-escaped. */
function pythonJson(body: Record<string, string | number>): string {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify(sorted).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Sign a Credential Service invocation token for one Turn or site sign-in:
 * `v1.<b64url(payload)>.<b64url(HMAC-SHA256(secret, payload segment))>`, unpadded.
 * A scope limits it to one Credential Service operation. The Credential
 * Service's Python verifier (`botcube_credential_service/invocation.py`) checks it.
 */
export function signCredentialServiceInvocation(
  secret: string,
  accountId: string,
  sessionId: string,
  { scope, model, now = Date.now() / 1000, ttlSeconds = TTL_SECONDS }: {
    scope?: string | undefined;
    model?: { provider: string; id: string };
    now?: number;
    ttlSeconds?: number;
  } = {},
): string {
  const key = secret.trim();
  const account = accountId.trim();
  const session = sessionId.trim();
  if (!key) throw new Error('CredentialService invocation secret is required');
  if (!account) throw new Error('Account id is required');
  if (!session) throw new Error('CredentialService invocation session id is required');
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
    throw new Error('CredentialService invocation lifetime must be a positive integer at most 3600 seconds');
  }
  const body: Record<string, string | number> = {
    account_id: account,
    session_id: session,
    expires_at: Math.floor(now) + ttlSeconds,
  };
  if (scope !== undefined) {
    if (!scope.trim()) throw new Error('CredentialService invocation scope must not be empty');
    body.scope = scope.trim();
  }
  if (model !== undefined) {
    if (!model.provider.trim() || !model.id.trim()) throw new Error('CredentialService model binding must not be empty');
    body.model_provider = model.provider.trim();
    body.model_id = model.id.trim();
  }
  const payload = Buffer.from(pythonJson(body)).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `v1.${payload}.${signature}`;
}

/**
 * A Turn's Credential Service binding: the service URL, and a token for the account and Session
 * that lasts as long as the Runtime (ADR 0029) and names the Turn's model, so the relay serves only it.
 */
export function turnCredentialBinding(
  url: string,
  secret: string,
  accountId: string,
  sessionId: string,
  model: { provider: string; key: string },
): { credentialServiceUrl: string; credentialServiceInvocationToken: string } {
  return {
    credentialServiceUrl: url,
    credentialServiceInvocationToken: signCredentialServiceInvocation(secret, accountId, sessionId, {
      model: { provider: model.provider, id: model.key.replace(/^openai-plan:/, '') },
      ttlSeconds: 3600,
    }),
  };
}

/** A verified invocation token: the account and Session it binds, and its scope. */
export interface CredentialServiceInvocation {
  accountId: string;
  sessionId: string;
  scope: string | undefined;
  modelProvider?: string;
  modelId?: string;
}

/**
 * Verify a token this module or the Python signer wrote: its signature under the
 * secret, its expiry, and its payload's shape, as the Credential Service's
 * verifier does. Answers null for any token it rejects.
 */
export function verifyCredentialServiceInvocation(
  secret: string,
  token: string,
  now = Date.now() / 1000,
): CredentialServiceInvocation | null {
  // Every token would verify under an empty key.
  if (!secret.trim()) return null;
  const [version, payload, signature, ...rest] = token.trim().split('.');
  if (version !== 'v1' || payload === undefined || signature === undefined || rest.length > 0) return null;
  const expected = Buffer.from(createHmac('sha256', secret.trim()).update(payload).digest('base64url'));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (body === null) return null;
  const { account_id: accountId, session_id: sessionId, scope, expires_at: expiresAt,
    model_provider: modelProvider, model_id: modelId } = body as Record<string, unknown>;
  if (!nonBlank(accountId) || !nonBlank(sessionId)) return null;
  if (scope !== undefined && !nonBlank(scope)) return null;
  if ((modelProvider !== undefined || modelId !== undefined) && (!nonBlank(modelProvider) || !nonBlank(modelId))) return null;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt < Math.floor(now)) return null;
  return {
    accountId: accountId.trim(), sessionId: sessionId.trim(), scope: scope?.trim(),
    ...(nonBlank(modelProvider) && nonBlank(modelId) ? { modelProvider: modelProvider.trim(), modelId: modelId.trim() } : {}),
  };
}

const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
