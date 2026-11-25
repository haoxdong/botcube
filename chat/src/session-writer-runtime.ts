import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './http-error.js';
import type { SessionPurge } from './session-identity.js';
import type { Upstream } from './upstream.js';

export type WriterLease = (() => Promise<void>) & {
  readonly session?: SessionPurge;
  readonly token?: string;
  readonly snapshotEpoch?: string;
  readonly postLeaseExpiresAt?: number;
};

interface SessionWriterHolder {
  token: string;
  createdAt: string;
}
export class SessionBusyError extends Error {
  constructor(message: string, readonly holder?: SessionWriterHolder) { super(message); }
}

export const NO_WRITER_WAIT = { timeoutMs: 0 };

export interface WriterWait {
  timeoutMs: number;
  signal?: AbortSignal;
  context?: { session_id: string; run_id: string };
}

export async function acquire<T>(register: () => Promise<T>, wait: WriterWait): Promise<T> {
  const deadline = Date.now() + wait.timeoutMs;
  for (let waiting = false;; waiting = true) {
    try {
      // eslint-disable-next-line no-await-in-loop -- recheck the durable fences on each attempt
      return await register();
    } catch (error) {
      if (!(error instanceof SessionBusyError) || wait.signal?.aborted) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        logWriterTimeout(wait.context, error.holder);
        throw error;
      }
      if (!waiting && wait.context !== undefined) console.warn('Waiting for the Session writer', wait.context, error);
      // eslint-disable-next-line no-await-in-loop -- wait for the current writer
      await delay(Math.min(1_000, remaining), undefined, { signal: wait.signal }).catch(() => { throw error; });
    }
  }
}

function logWriterTimeout(context: WriterWait['context'], holder: SessionWriterHolder | undefined): void {
  if (context === undefined) return;
  console.error('Session writer wait exceeded its budget', {
    ...context, holder_token: holder?.token, created_at: holder?.createdAt,
  });
}

interface RuntimeWriterTransport {
  runtimeTarget?: string;
  invokeRegistered(body: string, session: SessionPurge, complete: () => Promise<void>, init?: Parameters<Upstream['invoke']>[2], reject?: (error: unknown) => Promise<void>): Promise<Response>;
}

export async function runRuntimeWriter<T>(
  register: () => Promise<WriterLease>, wait: WriterWait, upstream: RuntimeWriterTransport, fallback: SessionPurge,
  run: (writer: { session: SessionPurge; snapshotEpoch?: string; invoke: Upstream['invoke'] }) => Promise<T>,
): Promise<T> {
  const lease = await acquire(register, wait);
  const session = lease.session ?? fallback;
  const state = { submitted: false };
  try {
    return await run({
      session, ...(lease.snapshotEpoch === undefined ? {} : { snapshotEpoch: lease.snapshotEpoch }),
      invoke: (body, _id, init) => {
        state.submitted = true;
        return upstream.invokeRegistered(body, session, () => lease(), init, (error) => classifyRejectedWriter(lease, upstream.runtimeTarget, error));
      },
    });
  } finally {
    if (!state.submitted) await lease();
  }
}

async function classifyRejectedWriter(writer: WriterLease & { markRejected?: (target: string) => Promise<void> }, target: string | undefined, error: unknown): Promise<void> {
  if (writer.markRejected === undefined) return;
  try {
    if (target === undefined) throw new HttpError(503, 'Runtime admission stop target is unproved');
    await writer.markRejected(target);
  } catch (classificationError) {
    throw new AggregateError([error, classificationError], 'Runtime writer failed and durable rejection classification failed', { cause: classificationError });
  }
}
