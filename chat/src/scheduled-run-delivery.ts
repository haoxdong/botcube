import { HttpError } from './http-error.js';
import { SessionBusyError, SessionDeletedError, type SessionMetadata } from './session-metadata.js';
import type { ScheduledDelivery, ScheduledRunStore } from './scheduled-run-store.js';
import type { ScheduledRunCard, SessionApiFor } from './session-api.js';
import type { sessionLifecycle } from './session-lifecycle.js';

export interface ScheduledDeliveryDeps {
  sessionMetadata: SessionMetadata;
  invokeSessionApi: SessionApiFor<'post'>;
  upstream: ReturnType<typeof sessionLifecycle> | null;
}

export async function postScheduledResult(deps: ScheduledDeliveryDeps, store: ScheduledRunStore, delivery: ScheduledDelivery, scheduledRun: ScheduledRunCard, options: { failed?: boolean } = {}): Promise<ScheduledDelivery> {
  const { sessionMetadata, invokeSessionApi } = deps;
  const posting = await sessionMetadata.runPost(() => beginScheduledPost(deps, store, delivery), { timeoutMs: Infinity }, store, delivery, {
    failed: options.failed === true, status: scheduledRun.status === 'skipped' ? undefined : scheduledRun.status,
  }, (session, expiresAt) => invokeSessionApi('post', {
    sessionId: delivery.mainChat, userId: session.filing_user_id,
    content: runSummary(scheduledRun), messageId: delivery.postMessageId, scheduledRun,
  }, expiresAt));
  await sessionMetadata.markPosted(delivery.owner, delivery.mainChat, posting.postMessageId);
  await store.complete(posting);
  return posting;
}

function runSummary({ title, status, text }: ScheduledRunCard): string {
  const said = { done: ':', failed: ' failed:', 'sign-in': ' could not finish:', skipped: ' skipped:' }[status];
  return `Scheduled task "${title}"${said} ${text}`;
}

async function beginScheduledPost(deps: ScheduledDeliveryDeps, store: ScheduledRunStore, delivery: ScheduledDelivery) {
  const metadata = deps.sessionMetadata;
  const upstream = deps.upstream;
  const recovery = upstream?.runtimeTarget === undefined ? undefined : {
    runtimeTarget: upstream.runtimeTarget,
    stopRejectedWriter: upstream.stopRejectedWriter,
  };
  const owner = await store.executionOwner(delivery);
  await assertReservedMainIdentity(metadata, delivery.owner, owner, delivery.mainChat, delivery.mainFilingUserId);
  try {
    return await metadata.beginDispatch(owner, delivery.mainChat, undefined, { messageId: delivery.postMessageId }, 'session-post', recovery);
  } catch (error) {
    if (error instanceof SessionDeletedError && await store.executionOwner(delivery) !== owner) {
      throw new SessionBusyError('Scheduled delivery moved during Account Claim');
    }
    throw error;
  }
}

export async function assertReservedMainIdentity(sessionMetadata: SessionMetadata, owner: string, executionOwner: string, mainChat: string, filingUserId: string | undefined): Promise<void> {
  if (executionOwner === owner) return;
  const main = await sessionMetadata.get(executionOwner, mainChat);
  if (filingUserId === undefined || main?.filing_user_id !== filingUserId) throw new HttpError(503, 'Reserved scheduled Main Chat identity is unavailable; delivery remains pending');
}

