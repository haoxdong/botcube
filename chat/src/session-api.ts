import { positiveInteger } from './config.js';
import pLimit from 'p-limit';
import { awsFetch } from './aws.js';
import { HttpError } from './cartridge.js';

/**
 * A request to the session API (ADR 0067 §5), which reads and purges a Session's record,
 * and reads and edits a user's Memory document, whose lines are AgentCore Memory records.
 */
type SessionApiEvent =
  /** Read history; a snapshot missing the `contains` Turn marker or message ID is rebuilt. */
  | { operation: 'get'; sessionId: string; userId: string; contains?: string }
  | { operation: 'purge'; sessionId: string; userId: string }
  /** Read the answered Turns of each Session, in one call. */
  | { operation: 'activity'; sessions: { sessionId: string; userId: string }[] }
  /** Add `content` to the Session as the agent's message, under `messageId`. */
  | { operation: 'post'; sessionId: string; userId: string; content: string; messageId: string }
  | { operation: 'memory'; userId: string }
  | { operation: 'memory-edit'; userId: string; recordId: string; text: string }
  | { operation: 'memory-delete'; userId: string; recordId: string };

/** Where the session API runs: the deployed function, invoked with SigV4, or its local plain-HTTP mode. */
export type SessionApiConfig =
  | { functionArn: string; region: string; endpoint?: string }
  | { localUrl: string }
  | null;

/**
 * Invokes the session API; a failure is an HttpError the client sees, a 503 when the session API
 * failed. Not a 502: Cloudflare, in front of the Chat Service, replaces an origin's 502 and 504 with
 * its own error page, which has no CORS headers, so the browser would see only "Failed to fetch".
 */
export type SessionApi = (event: SessionApiEvent, timeoutSeconds?: number) => Promise<Record<string, unknown>>;

/**
 * Session API calls one Chat Service process runs at once, queueing the rest. It matches the
 * session API alias's provisioned concurrency (SESSION_API_PROVISIONED_CONCURRENCY in the AgentCore
 * stack), so one process's calls land on initialized environments; while a draining task runs
 * beside its replacement, the extra calls spill over to on-demand environments. An environment that
 * just finished a call is briefly unavailable, so a queued call sent within ~150 ms can still spill
 * over to one cold on-demand environment (2 of 298 calls on Dev).
 */
const SESSION_API_CALLS_AT_ONCE = positiveInteger(process.env, 'BOTCUBE_SESSION_API_CALLS_AT_ONCE', 5);

/** The process's session API: one per Chat Service, so its calls share SESSION_API_CALLS_AT_ONCE. */
export function sessionApi(config: SessionApiConfig): SessionApi {
  const limit = pLimit(SESSION_API_CALLS_AT_ONCE);
  return (event, timeoutSeconds = 60) =>
    limit(async () => {
      if (config === null) throw new HttpError(503, 'The session API is not configured');
      const { status, body } =
        'functionArn' in config
          ? await invokeFunction(config, event, timeoutSeconds)
          : await invokeLocal(config.localUrl, event, timeoutSeconds);
      if (status === 404) throw new HttpError(404, String((body as { error: unknown }).error));
      if (status !== 200) {
        throw Object.assign(new HttpError(503, `Session API returned HTTP ${status}`), { cause: body });
      }
      return body as Record<string, unknown>;
    });
}

/** Invoke the deployed session API through Lambda Invoke, signed with SigV4. */
async function invokeFunction(
  { functionArn, region, endpoint }: { functionArn: string; region: string; endpoint?: string },
  event: SessionApiEvent,
  timeoutSeconds: number,
): Promise<{ status: number; body: unknown }> {
  const baseUrl = (endpoint || `https://lambda.${region}.amazonaws.com`).replace(/\/+$/, '');
  const url = `${baseUrl}/2015-03-31/functions/${encodeURIComponent(functionArn)}/invocations`;
  let response: Response;
  let payload: string;
  try {
    response = await awsFetch('lambda', region, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    payload = await response.text();
  } catch (error) {
    throw Object.assign(new HttpError(503, 'Session API request failed'), { cause: error });
  }
  if (!response.ok) {
    throw Object.assign(new HttpError(503, `Session API request failed: Lambda Invoke returned HTTP ${response.status}`), { cause: payload });
  }
  if (response.headers.has('x-amz-function-error')) {
    throw Object.assign(new HttpError(503, 'Session API function failed'), { cause: payload });
  }
  const result = jsonBody(payload, 'Session API function returned a result') as { statusCode: number; body: unknown };
  return { status: result.statusCode, body: result.body };
}

/** Invoke the session API's local plain-HTTP mode. */
async function invokeLocal(
  baseUrl: string,
  event: SessionApiEvent,
  timeoutSeconds: number,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    text = await response.text();
  } catch (error) {
    throw Object.assign(new HttpError(503, 'Session API request failed'), { cause: error });
  }
  return { status: response.status, body: jsonBody(text, `Session API returned HTTP ${response.status}`) };
}

/** A session API answer's JSON; anything else is a 503 naming what answered. */
function jsonBody(text: string, answered: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(503, `${answered} with a non-JSON body`);
  }
}
