import { decodeJwt } from 'jose';
import { HttpError } from './cartridge.js';
import { boundRuntime, type SessionPurge, type RegisteredDispatch } from './session-metadata.js';
import type { Upstream } from './upstream.js';

type Stop = (sessionId: string) => Promise<void | 'absent'>;

const sessionKey = (session: SessionPurge) => JSON.stringify([session.filing_user_id, session.session_id]);

/** Sandbox identity stays with its filing identity through Account Claim. */
export const runtimeSessionId = (session: SessionPurge): string => {
  if (!boundRuntime(session)) throw new HttpError(503, 'Session Runtime binding is unproved');
  return session.runtime_binding;
};

export function forwardSnapshotEpoch(props: Record<string, unknown>, complete: { readonly snapshotEpoch?: string | undefined }): void {
  delete props.sessionSnapshotEpoch;
  if (complete.snapshotEpoch === undefined || typeof props.turnIdentity !== 'string' || props.turnIdentity === '') return;
  const turnId = decodeJwt(props.turnIdentity).jti;
  if (typeof turnId === 'string' && turnId !== '') props.sessionSnapshotEpoch = { epoch: complete.snapshotEpoch, turnId };
}

/** A fenced Session cannot dispatch again, including a Turn admitted just before its metadata fence. */
export function sessionLifecycle(upstream: Upstream, stopRuntime?: Stop): Upstream & {
  fence(sessions: readonly SessionPurge[]): void;
  stop(session: SessionPurge): Promise<void | 'absent'>;
  settleFailedDispatch(session: SessionPurge): Promise<boolean>;
  failedDispatchTokens(session: SessionPurge): readonly string[];
  restoreFailedDispatch(session: SessionPurge, registrations: readonly RegisteredDispatch[]): void;
  invokeRegistered(body: string, session: SessionPurge, complete: () => Promise<void>, init?: Parameters<Upstream['invoke']>[2]): Promise<Response>;
} {
  const fenced = new Set<string>();
  const dispatches = new Map<string, Set<Promise<unknown>>>();
  const producers = new Map<string, Set<() => Promise<void>>>();
  const failures = new Map<string, unknown>();
  const settledRuntimes = new Set<string>();
  const confirmedStops = new Map<string, string>();
  const activeAdmissions = new Map<string, Map<RegisteredDispatch, string>>();
  const failedAdmissions = new Map<string, Map<RegisteredDispatch, string>>();

  const retainRejected = async (key: string, complete: RegisteredDispatch | undefined, sandboxId: string) => {
    if (complete === undefined || stopRuntime === undefined) return;
    if (complete.markRejected !== undefined) {
      if (upstream.runtimeTarget === undefined) throw new HttpError(503, 'Runtime admission stop target is unproved');
      await complete.markRejected(upstream.runtimeTarget);
    }
    const admissions = failedAdmissions.get(key) ?? new Map<RegisteredDispatch, string>();
    admissions.set(complete, sandboxId);
    failedAdmissions.set(key, admissions);
  };

  const acknowledgeAdmission = async (key: string, complete: RegisteredDispatch | undefined, sandboxId: string) => {
    try {
      await complete?.();
      if (complete !== undefined) {
        activeAdmissions.get(key)?.delete(complete);
        if (activeAdmissions.get(key)?.size === 0) activeAdmissions.delete(key);
      }
    }
    catch (error) {
      try { await retainRejected(key, complete, sandboxId); }
      catch (classificationError) {
        throw new AggregateError([error, classificationError],
          'Admission acknowledgement failed and durable classification failed', { cause: classificationError });
      }
      throw error;
    }
  };

  const invoke = async (body: string, sessionId: string, init?: Parameters<Upstream['invoke']>[2], complete?: RegisteredDispatch, session?: SessionPurge) => {
      const key = session === undefined ? JSON.stringify([null, sessionId]) : sessionKey(session);
      const sandboxId = session === undefined ? sessionId : runtimeSessionId(session);
      if (fenced.has(key)) { await complete?.(); throw new HttpError(410, 'The Session was deleted'); }
      const pending = dispatches.get(key) ?? new Set<Promise<unknown>>();
      dispatches.set(key, pending);
      if (complete !== undefined) {
        const admissions = activeAdmissions.get(key) ?? new Map<RegisteredDispatch, string>();
        admissions.set(complete, sandboxId);
        activeAdmissions.set(key, admissions);
      }
      const dispatched = upstream.invoke(body, sandboxId, init);
      pending.add(dispatched);
      let headersReceived = false;
      try {
        const response = await dispatched;
        headersReceived = true;
        if (response.body === null) { await acknowledgeAdmission(key, complete, sandboxId); return response; }
        const active = producers.get(key) ?? new Set<() => Promise<void>>();
        producers.set(key, active);
        const reader = response.body.getReader();
        let discard = false;
        let ended = false;
        let producerEnded = false;
        let reading: Promise<void> = Promise.resolve();
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let resolveDone: () => void;
        let rejectDone: (error: unknown) => void;
        const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
        // A failed producer remains a deletion blocker, even if it fails before deletion starts.
        void done.catch((error: unknown) => { if (!settledRuntimes.has(key)) failures.set(key, error); });
        const rejectProducer = async (error: unknown) => {
        let failure = error;
        if (!producerEnded && stopRuntime !== undefined && !settledRuntimes.has(key)) {
          try { await retainRejected(key, complete, sandboxId); }
          catch (classificationError) {
            failure = new AggregateError([error, classificationError], 'Producer failed and durable rejection classification failed', { cause: classificationError });
          }
        }
        ended = true;
        if (!discard) controller.error(failure);
        active.delete(drain);
        if (active.size === 0) producers.delete(key);
        rejectDone(failure);
        };
        const read = () => {
          reading = reading.then(async () => {
            if (ended) return;
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                producerEnded = true;
                await acknowledgeAdmission(key, complete, sandboxId);
                ended = true;
                if (!discard) controller.close();
                active.delete(drain);
                if (active.size === 0) producers.delete(key);
                resolveDone();
              } else if (!discard) controller.enqueue(chunk.value);
            } catch (error) {
              await rejectProducer(error);
            }
          });
          return reading;
        };
        const drain = async () => {
          if (!discard && !ended) { discard = true; controller.close(); }
          while (!ended) {
            // eslint-disable-next-line no-await-in-loop -- one producer reader, preserving byte order
            await read();
          }
          await done;
        };
        active.add(drain);
        const bodyStream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          pull: read,
          cancel() { discard = true; return drain(); },
        });
        return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        failures.set(key, error);
        if (!headersReceived) {
          try { await retainRejected(key, complete, sandboxId); }
          catch (classificationError) { throw new AggregateError([error, classificationError], 'Runtime admission failed and durable rejection classification failed', { cause: classificationError }); }
        }
        throw error;
      } finally {
        pending.delete(dispatched);
        if (pending.size === 0) dispatches.delete(key);
      }
    };

  const acknowledgeStopped = async (session: SessionPurge) => {
    const key = sessionKey(session);
    const admissions = failedAdmissions.get(key);
    for (const [complete, binding] of admissions ?? []) {
      if (binding !== runtimeSessionId(session)) throw new HttpError(503, 'Failed dispatch Runtime binding changed');
      // eslint-disable-next-line no-await-in-loop -- acknowledge each exact stopped admission, retaining any failed acknowledgement
      await complete.confirmStopped?.();
      // eslint-disable-next-line no-await-in-loop -- acknowledge only after persisting the exact confirmed Runtime stop
      await complete();
      admissions?.delete(complete);
      activeAdmissions.get(key)?.delete(complete);
      if (activeAdmissions.get(key)?.size === 0) activeAdmissions.delete(key);
    }
    if (admissions?.size === 0) failedAdmissions.delete(key);
  };

  const lifecycle = {
    label: upstream.label,
    ...(upstream.runtimeTarget === undefined ? {} : { runtimeTarget: upstream.runtimeTarget }),
    fence(sessions: readonly SessionPurge[]) {
      for (const session of sessions) fenced.add(sessionKey(session));
    },
    async stop(session: SessionPurge) {
      const key = sessionKey(session);
      fenced.add(key);
      // A request already sent can start a Sandbox after StopRuntimeSession. Wait for its headers first.
      await Promise.allSettled([...(dispatches.get(key) ?? [])]);
      if (stopRuntime !== undefined) {
        if (confirmedStops.get(key) === runtimeSessionId(session)) {
          await acknowledgeStopped(session);
          confirmedStops.delete(key);
          failures.delete(key);
          return undefined;
        }
        await Promise.all([...(activeAdmissions.get(key) ?? [])].map(([complete, binding]) =>
          retainRejected(key, complete, binding)));
        const stopped = await stopRuntime(runtimeSessionId(session));
        // Lost invocation headers leave an ambiguous submitted request. Absence
        // cannot prove it will not start later; only a successful stop clears it.
        if (stopped === 'absent' && (failures.has(key) || failedAdmissions.has(key))) throw failures.get(key) ?? new HttpError(503, 'Rejected Runtime admission settlement is unproved');
        if (stopped !== 'absent') {
          settledRuntimes.add(key);
          if (failedAdmissions.has(key)) confirmedStops.set(key, runtimeSessionId(session));
          await acknowledgeStopped(session);
          confirmedStops.delete(key);
        }
        failures.delete(key);
        return stopped;
      }
      // Local mode has no Sandbox-stop API: only producer EOF proves its finally/flush finished.
      await Promise.all([...(producers.get(key) ?? [])].map((drain) => drain()));
      if (failures.has(key)) throw failures.get(key);
    },
    async settleFailedDispatch(session: SessionPurge) {
      if (!failedAdmissions.has(sessionKey(session))) return false;
      await lifecycle.stop(session);
      return true;
    },
    failedDispatchTokens(session: SessionPurge) {
      return [...(failedAdmissions.get(sessionKey(session)) ?? [])].flatMap(([complete, binding]) =>
        complete.token !== undefined && complete.session?.runtime_binding === binding && binding === runtimeSessionId(session) ? [complete.token] : []);
    },
    restoreFailedDispatch(session: SessionPurge, registrations: readonly RegisteredDispatch[]) {
      const key = sessionKey(session);
      const admissions = failedAdmissions.get(key) ?? new Map<RegisteredDispatch, string>();
      for (const registration of registrations) {
        if (![...admissions.keys()].some((existing) => existing.token === registration.token)) admissions.set(registration, runtimeSessionId(session));
      }
      if (admissions.size === 0) return;
      failedAdmissions.set(key, admissions);
      if ([...admissions.keys()].every((registration) => registration.stopConfirmed === true)) confirmedStops.set(key, runtimeSessionId(session));
    },
    invoke,
    invokeRegistered: (body: string, session: SessionPurge, complete: () => Promise<void>, init?: Parameters<Upstream['invoke']>[2]) => invoke(body, session.session_id, init, complete, session),

  };
  return lifecycle;
}
