import { HttpError } from './http-error.js';
import { SessionBusyError, SessionDeletedError, type SessionMetadata } from './session-metadata.js';
import type { ScheduledDelivery, ScheduledRunStore } from './scheduled-run-store.js';
import type { ScheduledRunCard, SessionApi } from './session-api.js';
import type { sessionLifecycle } from './session-lifecycle.js';

export interface ScheduledDeliveryDeps {
  sessionMetadata: SessionMetadata;
  invokeSessionApi: SessionApi;
  upstream: ReturnType<typeof sessionLifecycle> | null;
}

export async function postScheduledResult(deps: ScheduledDeliveryDeps, store: ScheduledRunStore, delivery: ScheduledDelivery, scheduledRun: ScheduledRunCard, options: { failed?: boolean } = {}): Promise<ScheduledDelivery> {
  const { sessionMetadata, invokeSessionApi } = deps;
  const mainChat = delivery.mainChat;
  const owner = delivery.owner;
  const messageId = delivery.postMessageId;
  const complete = await beginScheduledPost(deps, store, delivery);
  if (complete.session === undefined) throw new HttpError(503, 'Scheduled post filing identity is unavailable');
  const userId = complete.session.filing_user_id;
  if (complete.markSucceeded === undefined || complete.postLeaseExpiresAt === undefined) throw new HttpError(503, 'Scheduled post registration is unavailable');
  const posting = await store.posting(delivery, complete, options.failed === true, scheduledRun.status === 'skipped' ? undefined : scheduledRun.status);
  await invokeSessionApi({ operation: 'post', sessionId: mainChat, userId, content: runSummary(scheduledRun), messageId, scheduledRun }, undefined, complete.postLeaseExpiresAt);
  await complete.markSucceeded('session-post', store.postedTransaction(posting));
  await sessionMetadata.markPosted(owner, mainChat, posting.postMessageId);
  await complete();
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
    settle: async (...args: Parameters<typeof upstream.recoverRejectedWriters>) => {
      try {
        await upstream.recoverRejectedWriters(...args);
      } catch (error) {
        console.warn('Scheduled post is retrying rejected Runtime writer recovery', error);
        await upstream.recoverRejectedWriters(...args);
      }
    },
  };
  const attempt = async () => {
    const owner = await store.executionOwner(delivery);
    await assertReservedMainIdentity(metadata, delivery.owner, owner, delivery.mainChat, delivery.mainFilingUserId);
    try {
      return await metadata.beginDispatch(owner, delivery.mainChat, undefined, { messageId: delivery.postMessageId }, 'session-post', recovery);
    } catch (error) {
      if (error instanceof SessionDeletedError && await store.executionOwner(delivery) !== owner) return null;
      if (error instanceof SessionBusyError) return null;
      throw error;
    }
  };
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- retain the completed outcome until the current owner's Main writer settles
    const complete = await attempt();
    if (complete !== null) return complete;
    // eslint-disable-next-line no-await-in-loop -- contention and a proved Claim handoff wait without fencing newer Runtime admissions
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function assertReservedMainIdentity(sessionMetadata: SessionMetadata, owner: string, executionOwner: string, mainChat: string, filingUserId: string | undefined): Promise<void> {
  if (executionOwner === owner) return;
  const main = await sessionMetadata.get(executionOwner, mainChat);
  if (filingUserId === undefined || main?.filing_user_id !== filingUserId) throw new HttpError(503, 'Reserved scheduled Main Chat identity is unavailable; delivery remains pending');
}

