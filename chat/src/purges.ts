import { stillServing } from './task-drain.js';
import type { SessionApi } from './session-api.js';
import { RuntimeAdmissionUnprovedError } from './session-lifecycle.js';
import { SessionDispatchPendingError, type SessionPurge } from './session-metadata.js';

// A purge that fails (session API cold start, throttling, a network blip) is
// retried after each of these waits before the failure is logged.
const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000];

/**
 * Sessions an account erase purges at once. AgentCore allows 20 DeleteEvent calls a second per AWS
 * account, and each session API environment paces itself to 5, so four saturate it; it also leaves one
 * of the process's SESSION_API_CALLS_AT_ONCE for page loads. Serial, a 1,948-Session account outlived
 * every task that tried it.
 */
const ERASE_AT_ONCE = 4;

/** An account erase logs its progress at most this often. */
const PROGRESS_EVERY_MS = 60_000;

/**
 * Purges fenced Sessions' events one at a time, after the response, retrying a
 * failure after each backoff in turn. A Session is purged under every actor that
 * filed into it: its filing ID and, after Account Claim, its owner's actor
 * (`ownerActorId`), under which the claiming account's Turns file (ADR 0067 §8).
 * Only an anonymous account is claimed, into a registered one that is never
 * claimed in turn, so these two are all. Background purges run one at a time;
 * recovery yields between Sessions to newly requested deletions. Account erasure
 * waits only for its own Sessions, ERASE_AT_ONCE at a time. The session API paces
 * each purge to the per-Session rate.
 *
 * The documented transient choke point for purges (ADR 0030): nobody waits on a
 * background purge, and the UI no longer lists the Session to delete it again.
 * Once retries run out, the failure is logged, which alarms, and the fence stays
 * up. An unproved Runtime admission stays terminal in this queue after retry
 * exhaustion; an explicit wait can retry it. Other failures
 * permit another deletion request to retry.
 */
export function purgeQueue(
  invoke: SessionApi,
  ownerActorId: (owner: string) => string,
  stop: (session: SessionPurge) => Promise<void | 'absent'>,
  backoffMs: readonly number[] = RETRY_BACKOFF_MS,
  complete: (session: SessionPurge) => Promise<void> = async () => undefined,
  retainUnproved: (session: SessionPurge) => Promise<void> = async () => undefined,
  draining: () => Promise<boolean> = async () => false,
  eraseAtOnce = ERASE_AT_ONCE,
): ((sessions: SessionPurge[]) => void) & { recover(sessions: SessionPurge[]): void; wait(sessions: SessionPurge[]): Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  const recovered: SessionPurge[] = [];
  let recovering = false;
  const jobKey = ({ filing_user_id, session_id }: SessionPurge) => JSON.stringify([filing_user_id, session_id]);

  async function recoverNext(): Promise<void> {
    const session = recovered.shift();
    if (session === undefined) {
      recovering = false;
      return;
    }
    await purge(session);
    tail = tail.then(recoverNext);
  }

  async function observeAgain(session: SessionPurge, failures: number, pending: number): Promise<void> {
    if (await stillServing(draining)) return purge(session, failures, pending);
    queued.delete(jobKey(session));
  }

  async function erase(session: SessionPurge): Promise<void> {
    if (await stop(session) === 'absent') console.info(`Session Sandbox is absent; purging remaining Session events. session_id=${session.session_id}`);
    const actorIds = new Set([session.filing_user_id, ...(session.owner === undefined ? [] : [ownerActorId(session.owner)])]);
    for (const userId of actorIds) {
      // eslint-disable-next-line no-await-in-loop -- one actor's purge at a time keeps within AgentCore's delete rate
      await invoke({ operation: 'purge', sessionId: session.session_id, userId }, 900);
    }
    await complete(session);
  }

  async function failPurge(session: SessionPurge, error: unknown): Promise<void> {
    if (!(error instanceof RuntimeAdmissionUnprovedError)) queued.delete(jobKey(session));
    // The Session-purge alarm's metric filter matches this literal.
    console.error(`Session purge failed; the Session stays fenced. session_id=${session.session_id}`, error);
    if (error instanceof RuntimeAdmissionUnprovedError) {
      try {
        await retainUnproved(session);
      } catch (persistenceError) {
        queued.delete(jobKey(session));
        console.error(`Session purge failed; recording the unproved admission fence failed. session_id=${session.session_id}`, persistenceError);
      }
    }
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
          // fenced Session until that registration clears or turns 3 h old (REGISTRATION_EXPIRY_MS).
          if (pending === backoffMs.length) {
            console.error(`Session purge failed; the Session stays fenced. session_id=${sessionId}`, error);
          }
          const wait = backoffMs[Math.min(pending, backoffMs.length - 1)] ?? 5_000;
          // Rejoin the serial queue after waiting: a stranded writer must not
          // hold unrelated Sessions behind it. The timer cannot keep a task alive.
          setTimeout(() => { tail = tail.then(() => observeAgain(session, failures, pending + 1)); }, wait).unref();
          return;
        }
        if (backoff === undefined) {
          return failPurge(session, error);
        }
        failures += 1;
        console.warn(`Session purge attempt failed; retrying in ${backoff / 1000}s. session_id=${sessionId}`, error);
        // eslint-disable-next-line no-await-in-loop -- retries after each backoff
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  /**
   * Erases an account's Sessions, ERASE_AT_ONCE at a time. A failure halves how many run at once and is retried
   * after each backoff in turn. Once a failure is final, the erase stops starting Sessions and rejects after the
   * running ones settle. A registered writer or an unproved admission is no throttling: that Session is skipped at
   * once, the rest are erased, and the erase then rejects with the first such error. Completed Sessions stay
   * completed, so a later erase resumes.
   */
  async function eraseAll(sessions: SessionPurge[]): Promise<void> {
    let next = 0;
    let done = 0;
    let atOnce = eraseAtOnce;
    let failure: { error: unknown } | undefined;
    let skipped: { error: unknown } | undefined;
    let reported = Date.now();
    // Another worker sets `failure` while this one awaits.
    const failed = () => failure !== undefined;
    /** Erases one Session, retrying a failure after each backoff; whether it was erased, or skipped as fenced. */
    const eraseOne = async (session: SessionPurge): Promise<'erased' | 'skipped' | 'failed'> => {
      for (let failures = 0; ; failures += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- each worker erases one Session at a time
          await erase(session);
          return 'erased';
        } catch (error) {
          if (error instanceof SessionDispatchPendingError || error instanceof RuntimeAdmissionUnprovedError) {
            skipped ??= { error };
            return 'skipped';
          }
          const backoff = backoffMs[failures];
          if (backoff === undefined || failed()) {
            failure ??= { error };
            return 'failed';
          }
          atOnce = Math.max(1, Math.floor(atOnce / 2));
          console.warn(`Session purge attempt failed; retrying in ${backoff / 1000}s with ${atOnce} at once. session_id=${session.session_id}`, error);
          // eslint-disable-next-line no-await-in-loop -- retries after each backoff
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    };
    const worker = async (slot: number): Promise<void> => {
      while (!failed() && slot < atOnce && next < sessions.length) {
        // eslint-disable-next-line no-await-in-loop -- each worker erases one Session at a time
        const outcome = await eraseOne(sessions[next++] as SessionPurge);
        if (outcome !== 'erased') continue;
        done += 1;
        if (Date.now() - reported >= PROGRESS_EVERY_MS) {
          reported = Date.now();
          console.info(`Account history erase purged ${done} of ${sessions.length} Sessions`);
        }
      }
    };
    await Promise.all(Array.from({ length: eraseAtOnce }, (_, slot) => worker(slot)));
    const rejection = failure ?? skipped;
    if (rejection !== undefined) throw rejection.error;
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
    recover(sessions: SessionPurge[]) {
      for (const session of sessions) {
        const id = jobKey(session);
        if (queued.has(id)) continue;
        queued.add(id);
        recovered.push(session);
      }
      if (recovering) return;
      recovering = true;
      tail = tail.then(recoverNext);
    },
    wait(sessions: SessionPurge[]) {
      const result = eraseAll(sessions);
      void result.catch((error: unknown) => { console.error('Session purge failed; account history deletion remains pending', error); });
      return result;
    },
  });
}
