import type { SessionApi } from './session-api.js';
import type { SessionSummary } from './session-metadata.js';

// A purge that fails (session API cold start, throttling, a network blip) is
// retried after each of these waits before the failure is logged.
const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000];

/**
 * Purges fenced Sessions' events one at a time, after the response, retrying a
 * failure after each backoff in turn. One at a time keeps this process within
 * AgentCore's account-wide delete rate; the session API paces each purge to the
 * per-Session rate.
 *
 * The documented transient choke point for purges (ADR 0030): nobody waits on a
 * background purge, and the UI no longer lists the Session to delete it again.
 * Once retries run out, the failure is logged, which alarms, and the fence stays
 * up; deleting again retries.
 */
export function purgeQueue(
  invoke: SessionApi,
  backoffMs: readonly number[] = RETRY_BACKOFF_MS,
): (sessions: SessionSummary[]) => void {
  let tail: Promise<void> = Promise.resolve();

  async function purge({ session_id: sessionId, filing_user_id: userId }: SessionSummary): Promise<void> {
    // One attempt after each backoff, and a first one before them.
    for (const backoff of [...backoffMs, undefined]) {
      try {
        // Paced to AgentCore's per-event delete rate, a long Session takes minutes.
        // eslint-disable-next-line no-await-in-loop -- retries after each backoff
        await invoke({ operation: 'purge', sessionId, userId }, 900);
        return;
      } catch (error) {
        if (backoff === undefined) {
          // The Session-purge alarm's metric filter matches this literal.
          console.error(`Session purge failed; the Session stays fenced. session_id=${sessionId}`, error);
          return;
        }
        console.warn(`Session purge attempt failed; retrying in ${backoff / 1000}s. session_id=${sessionId}`, error);
        // eslint-disable-next-line no-await-in-loop -- retries after each backoff
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  return (sessions) => {
    for (const session of sessions) tail = tail.then(() => purge(session));
  };
}
