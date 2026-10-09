import type { SessionApi } from './session-api.js';
import { SessionDispatchPendingError, type SessionPurge } from './session-metadata.js';

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
  stop: (session: SessionPurge) => Promise<void | 'absent'>,
  backoffMs: readonly number[] = RETRY_BACKOFF_MS,
  complete: (session: SessionPurge) => Promise<void> = async () => undefined,
): ((sessions: SessionPurge[]) => void) & { wait(sessions: SessionPurge[]): Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  const jobKey = ({ filing_user_id, session_id }: SessionPurge) => JSON.stringify([filing_user_id, session_id]);

  async function erase(session: SessionPurge): Promise<void> {
    if (await stop(session) === 'absent') console.info(`Session Sandbox is absent; purging remaining Session events. session_id=${session.session_id}`);
    await invoke({ operation: 'purge', sessionId: session.session_id, userId: session.filing_user_id }, 900);
    await complete(session);
  }

  async function purge(session: SessionPurge, failures = 0, pending = 0): Promise<void> {
    const { session_id: sessionId } = session;
    // One attempt after each backoff, and a first one before them.
    while (failures <= backoffMs.length) {
      const backoff = backoffMs[failures];
      try {
        // eslint-disable-next-line no-await-in-loop -- each retry stops the writer before erasing its records
        await erase(session);
        queued.delete(jobKey(session));
        return;
      } catch (error) {
        if (error instanceof SessionDispatchPendingError) {
          // Another task releases only its durable row, so keep observing the
          // fenced Session until that registration clears. No expiry authorizes purge.
          if (pending === backoffMs.length) {
            console.error(`Session purge failed; the Session stays fenced. session_id=${sessionId}`, error);
          }
          const wait = backoffMs[Math.min(pending, backoffMs.length - 1)] ?? 5_000;
          // Rejoin the serial queue after waiting: a stranded writer must not
          // hold unrelated Sessions behind it. The timer cannot keep a task alive.
          setTimeout(() => { tail = tail.then(() => purge(session, failures, pending + 1)); }, wait).unref();
          return;
        }
        if (backoff === undefined) {
          queued.delete(jobKey(session));
          // The Session-purge alarm's metric filter matches this literal.
          console.error(`Session purge failed; the Session stays fenced. session_id=${sessionId}`, error);
          return;
        }
        failures += 1;
        console.warn(`Session purge attempt failed; retrying in ${backoff / 1000}s. session_id=${sessionId}`, error);
        // eslint-disable-next-line no-await-in-loop -- retries after each backoff
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  const enqueue = (sessions: SessionPurge[]) => {
    for (const session of sessions) {
      const id = jobKey(session);
      if (queued.has(id)) continue;
      queued.add(id);
      tail = tail.then(() => purge(session));
    }
  };
  return Object.assign(enqueue, {
    wait(sessions: SessionPurge[]) {
      const result = tail.then(async () => {
        for (const session of sessions) {
          // eslint-disable-next-line no-await-in-loop -- account erasure must settle each producer before Files erasure
          await erase(session);
        }
      });
      tail = result.catch((error: unknown) => { console.error('Session purge failed; account history deletion remains pending', error); });
      return result;
    },
  });
}
