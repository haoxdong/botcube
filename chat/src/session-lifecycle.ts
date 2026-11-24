import { decodeJwt } from 'jose';
import { HttpError } from './http-error.js';
import type { SessionPurge } from './session-metadata.js';
import type { Upstream } from './upstream.js';

type Stop = (sessionId: string) => Promise<void | 'absent'>;

export class RuntimeAdmissionUnprovedError extends HttpError {
  constructor(override readonly cause?: unknown) {
    super(503, 'Rejected Runtime admission settlement is unproved; automatic purge retries are bounded. Keep the Session fenced until exact Runtime stop is confirmed.', 'RUNTIME_ADMISSION_UNPROVED');
  }
}

const sessionKey = (session: SessionPurge) => JSON.stringify([session.filing_user_id, session.session_id]);

/** Sandbox identity stays with its filing identity through Account Claim. */
/** One Session ID per chat: a chat's Sandbox ID is its Session ID. */
export const runtimeSessionId = (session: SessionPurge): string => session.session_id;

export function forwardSnapshotEpoch(props: Record<string, unknown>, complete: { readonly snapshotEpoch?: string | undefined }): void {
  delete props.sessionSnapshotEpoch;
  const identity = props.turnIdentity;
  if (complete.snapshotEpoch === undefined || identity === '' || (typeof identity !== 'string' && (identity === null || typeof identity !== 'object'))) return;
  const turnId = typeof identity === 'string' ? decodeJwt(identity).jti : (identity as { turnId?: unknown }).turnId;
  if (typeof turnId === 'string' && turnId !== '') props.sessionSnapshotEpoch = { epoch: complete.snapshotEpoch, turnId };
}

/** A fenced Session cannot dispatch again, including a Turn admitted just before its metadata fence. */
export function sessionLifecycle(upstream: Upstream, stopRuntime?: Stop): Upstream & {
  fence(sessions: readonly SessionPurge[]): void;
  stop(session: SessionPurge): Promise<void | 'absent'>;
  stopRejectedWriter(session: SessionPurge): Promise<void>;
  invokeRegistered(body: string, session: SessionPurge, complete: () => Promise<void>, init?: Parameters<Upstream['invoke']>[2], reject?: (error: unknown) => Promise<void>): Promise<Response>;
} {
  const fenced = new Set<string>();
  const dispatches = new Map<string, Set<Promise<unknown>>>();
  const producers = new Map<string, Set<() => Promise<void>>>();
  const invoke = async (body: string, sessionId: string, init?: Parameters<Upstream['invoke']>[2], complete?: () => Promise<void>, session?: SessionPurge, reject?: (error: unknown) => Promise<void>) => {
      const classify = stopRuntime === undefined ? undefined : reject;
      const acknowledge = async () => {
        try { await complete?.(); }
        catch (error) { await classify?.(error); throw error; }
      };
      const key = session === undefined ? JSON.stringify([null, sessionId]) : sessionKey(session);
      const sandboxId = session === undefined ? sessionId : runtimeSessionId(session);
      if (fenced.has(key)) { await complete?.(); throw new HttpError(410, 'The Session was deleted'); }
      const pending = dispatches.get(key) ?? new Set<Promise<unknown>>();
      dispatches.set(key, pending);
      const dispatched = (async () => upstream.invoke(body, sandboxId, init))();
    pending.add(dispatched);
      let headersReceived = false;
      try {
        const response = await dispatched;
        headersReceived = true;
        if (response.body === null) { await acknowledge(); return response; }
        const active = producers.get(key) ?? new Set<() => Promise<void>>();
        producers.set(key, active);
        const reader = response.body.getReader();
        let discard = false;
        let ended = false;
        let producerEnded = false;
        let reading: Promise<void> = Promise.resolve();
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let producerFailure: { error: unknown } | undefined;
        const rejectProducer = async (error: unknown) => {
          let failure = error;
          if (!producerEnded) {
            try { await classify?.(error); }
            catch (classificationError) { failure = classificationError; }
          }
          producerFailure = { error: failure };
          ended = true;
          if (!discard) controller.error(failure);
          active.delete(drain);
          if (active.size === 0) producers.delete(key);
        };
        const read = () => {
          reading = reading.then(async () => {
            if (ended) return;
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                producerEnded = true;
                await acknowledge();
                ended = true;
                if (!discard) controller.close();
                active.delete(drain);
                if (active.size === 0) producers.delete(key);
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
          if (producerFailure !== undefined) throw producerFailure.error;
        };
        active.add(drain);
        const bodyStream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          pull: read,
          cancel() { discard = true; return drain(); },
        });
        return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        if (!headersReceived) await classify?.(error);
        throw error;
      } finally {
        pending.delete(dispatched);
        if (pending.size === 0) dispatches.delete(key);
      }
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
      if (stopRuntime !== undefined) return stopRuntime(runtimeSessionId(session));
      await Promise.all([...(producers.get(key) ?? [])].map((drain) => drain()));
    },
    async stopRejectedWriter(session: SessionPurge) {
      if (stopRuntime === undefined || await stopRuntime(runtimeSessionId(session)) === 'absent') {
        throw new RuntimeAdmissionUnprovedError();
      }
    },
    invoke,
    invokeRegistered: (body: string, session: SessionPurge, complete: () => Promise<void>, init?: Parameters<Upstream['invoke']>[2], reject?: (error: unknown) => Promise<void>) => invoke(body, session.session_id, init, complete, session, reject),

  };
  return lifecycle;
}
