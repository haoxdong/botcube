import { acquire, type WriterLease, type WriterWait } from './session-writer-runtime.js';
import { createHash } from 'node:crypto';
import { dispatchKey, dispatcherId, postingProof, POST_LEASE_AVAILABLE, recoveryConditions, registerWriter, writerBusy, writerControlKey } from './session-writer-registration.js';
import { type CancellationReason, ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './http-error.js';
import { namedTransaction, type TransactionWrite as TransactItem } from './named-transaction.js';
import type { ScheduledDelivery, ScheduledRunStore } from './scheduled-run-store.js';
import type { ScheduledTaskRun } from './scheduled-tasks.js';
import type { SessionPurge } from './session-identity.js';

export class SessionDispatchPendingError extends Error {}

type RegisteredDispatch = WriterLease & {
  markRejected?: (runtimeTarget: string) => Promise<void>;
  markSucceeded?: (kind: 'session-post', completion?: TransactItem) => Promise<void>;
  confirmStopped?: () => Promise<void>;
  stopConfirmed?: boolean;
};

type RegisteredSessionDispatch = RegisteredDispatch & { readonly session: SessionPurge };
export interface RejectedWriterRecovery {
  runtimeTarget: string;
  stopRejectedWriter(session: SessionPurge): Promise<void>;
}

// ADR 0029: one hour for the Sandbox, two more for task drain and stop.
export const REGISTRATION_EXPIRY_MS = 3 * 3_600_000;
const WRITER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const registrationExpired = (created: string, now: number) => Date.parse(created) + REGISTRATION_EXPIRY_MS < now;

type WriterItem = { pk: string; sk: string; dispatcher?: string } & Record<string, unknown>;

interface WriterStop {
  runtimeTarget?: string;
  stopRejectedWriter: RejectedWriterRecovery['stopRejectedWriter'];
  fence(sessions: readonly SessionPurge[]): void;
  stop(session: SessionPurge): Promise<void | 'absent'>;
}

export class SessionWriters {
  constructor(private readonly tableName: string, private readonly documents: DynamoDBDocumentClient) {}

  dispatchTransaction(session: SessionPurge, token: string, fences: ReadonlyArray<readonly ['ownerFence' | 'claimFence' | 'session', TransactItem]>, destination?: TransactItem, post?: {
    expiresAt: number; now: number; rejected: readonly RegisteredDispatch[]; target: string | undefined;
  }) {
    const [registration, control] = registerWriter(this.tableName, session, token, post?.now, post?.expiresAt, post?.rejected.length);
    const checks = post?.target === undefined ? [] : recoveryConditions(this.tableName, session, post.target, post.rejected.map(({ token }) => {
      if (token === undefined) throw new SessionDispatchPendingError('Rejected writer identity is unproved');
      return token;
    }));
    return namedTransaction([
      ...fences, ['registration', registration],
      ...(destination === undefined ? [] : [['destinationFence', destination]] as const),
      ['writerControl', control], ...checks.map((check) => ['recovery', check] as const),
    ]);
  }

  async registered(session: SessionPurge, token: string, epoch: string, expiresAt: number | undefined,
    rejected: readonly RegisteredDispatch[], stop?: RejectedWriterRecovery['stopRejectedWriter'],
  ): Promise<RegisteredSessionDispatch> {
    if (expiresAt === undefined) return this.acknowledgement(session, token, false, false, undefined, 'runtime', epoch);
    try {
      if (rejected.length > 0 && stop !== undefined) await recoverRejectedWriters(session, rejected, stop);
    } catch (error) {
      await this.abandonPost(session, token);
      throw error;
    }
    return Object.assign(this.acknowledgement(session, token, false, false, undefined, 'session-post'), { postLeaseExpiresAt: expiresAt });
  }

  async refuseAdmission(session: SessionPurge, reason: CancellationReason, at?: number): Promise<true> {
    if (at !== undefined && Number(reason.Item?.runtime_writers?.N) > 0 && await this.settleExpired(session, at, true)) return true;
    throw writerBusy(reason, REGISTRATION_EXPIRY_MS);
  }

  async completePurge(session: SessionPurge, completion: TransactItem): Promise<void> {
    const transaction = namedTransaction([['purge', completion], ['writerControl', { Delete: {
      TableName: this.tableName, Key: writerControlKey(session),
      ConditionExpression: POST_LEASE_AVAILABLE + ' AND (attribute_not_exists(runtime_writers) OR runtime_writers = :zero)',
      ExpressionAttributeValues: { ':zero': 0, ':now': Date.now() },
    } }]]);
    try {
      await this.documents.send(transaction.command);
    } catch (error) {
      if (transaction.conditions(error).failed.has('writerControl')) {
        throw new SessionDispatchPendingError('Session writer is still active', { cause: error });
      }
      throw error;
    }
  }

  acknowledgement(session: SessionPurge, token: string, recovered = false, stopped = false, runtimeTarget?: string, writerKind?: 'runtime' | 'session-post', snapshotEpoch?: string): RegisteredSessionDispatch {
    const Key = dispatchKey(session, token);
    const binding = { ':binding': session.session_id };
    const complete: RegisteredSessionDispatch = Object.assign(async () => {
      const condition = recovered
        ? 'rejected_runtime_binding = :binding AND rejected_runtime_target = :target AND runtime_stop_confirmed = :binding'
        : 'attribute_exists(pk)' + (writerKind === 'session-post' ? ' AND writer_succeeded = :kind' : '');
      const values = recovered ? { ...binding, ':target': runtimeTarget } : writerKind === 'session-post' ? { ':kind': 'session-post' } : writerKind === 'runtime' ? binding : undefined;
      await this.settleRegistration(session, token, condition + (!recovered && writerKind === 'runtime' ? ' AND (attribute_not_exists(rejected_runtime_binding) OR runtime_stop_confirmed = :binding)' : ''), values, writerKind, recovered);
    }, { session, token, stopConfirmed: stopped, ...(snapshotEpoch === undefined ? {} : { snapshotEpoch }) });
    complete.markSucceeded = async (kind, completion) => {
      const completionProof = createHash('sha256').update(JSON.stringify(completion ?? null)).digest('hex');
      const Update = { TableName: this.tableName, Key,
        UpdateExpression: 'SET writer_succeeded = :kind, writer_completion = :completion',
        ConditionExpression: 'dispatcher = :dispatcher AND session_id = :session AND filing_user_id = :filing',
        ExpressionAttributeValues: { ':dispatcher': dispatcherId, ':session': session.session_id, ':filing': session.filing_user_id, ':kind': kind, ':completion': completionProof },
      };
      if (completion !== undefined && completion.Update?.TableName !== this.tableName) throw new SessionDispatchPendingError('Successful writer completion transaction is invalid');
      if (writerKind !== 'session-post' && completion === undefined) {
        await this.documents.send(new UpdateCommand(Update));
        return;
      }
      try {
        await this.documents.send(new TransactWriteCommand({ TransactItems: [
          { Update }, ...(completion === undefined ? [] : [completion]),
          ...(writerKind === 'session-post' ? [this.releasePostLease(session, token)] : []),
        ] }));
      } catch (error) {
        if (writerKind !== 'session-post' || !(error as Partial<TransactionCanceledException>).CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) throw error;
        const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
        if (Item?.writer_succeeded !== 'session-post' || Item.writer_completion !== completionProof || Item.session_id !== session.session_id || Item.filing_user_id !== session.filing_user_id) throw error;
      }
    };
    complete.markRejected = async (target) => {
      await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key,
        UpdateExpression: 'SET rejected_runtime_binding = :binding, rejected_runtime_target = :target',
        ConditionExpression: 'dispatcher = :dispatcher AND attribute_exists(pk)',
        ExpressionAttributeValues: { ...binding, ':dispatcher': dispatcherId, ':target': target },
      }));
      runtimeTarget = target;
    };
    complete.confirmStopped = async () => {
      if (runtimeTarget === undefined) throw new SessionDispatchPendingError('Rejected Runtime target is unproved');
      await this.confirmDispatchStop(Key, { ...binding, ':target': runtimeTarget });
      complete.stopConfirmed = true;
    };
    return complete;
  }

  private async settleRegistration(session: SessionPurge, token: string, condition: string, values: Record<string, unknown> | undefined, kind?: 'runtime' | 'session-post', archive = false): Promise<void> {
    const Key = dispatchKey(session, token);
    const backup = archive ? await this.registrationBackup(Key) : [];
    try {
      await this.documents.send(new TransactWriteCommand({ TransactItems: [
        ...backup,
        { Delete: { TableName: this.tableName, Key, ConditionExpression: condition + (kind === undefined ? '' : ' AND writer_control = :writer_kind'), ...((values === undefined && kind === undefined) ? {} : { ExpressionAttributeValues: { ...values, ...(kind === undefined ? {} : { ':writer_kind': kind }) } }) } },
        ...(kind === 'runtime' ? [{ Update: {
          TableName: this.tableName, Key: writerControlKey(session), UpdateExpression: 'ADD runtime_writers :minus_one',
          ConditionExpression: 'runtime_writers > :zero', ExpressionAttributeValues: { ':minus_one': -1, ':zero': 0 },
        } }] : []),
      ] }));
    } catch (error) {
      if (!(error as Partial<TransactionCanceledException>).CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) throw error;
      const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
      if (Item !== undefined && !(archive && Item.writer_succeeded === 'session-post')) {
        throw new SessionDispatchPendingError('Writer completion is unproved', { cause: error });
      }
    }
  }

  private async registrationBackup(Key: ReturnType<typeof dispatchKey>): Promise<TransactItem[]> {
    const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
    return Item === undefined ? [] : [{ Put: {
      TableName: this.tableName,
      Item: { pk: Key.pk.replace('DISPATCH#', 'DISPATCH_BACKUP#'), sk: Key.sk, registration: Item, archivedAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(pk)',
    } }];
  }

  private async confirmDispatchStop(Key: ReturnType<typeof dispatchKey>, binding: { ':binding': string; ':target': string }): Promise<void> {
    try {
      await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key,
        UpdateExpression: 'SET runtime_stop_confirmed = :binding',
        ConditionExpression: 'rejected_runtime_binding = :binding AND rejected_runtime_target = :target',
        ExpressionAttributeValues: binding,
      }));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
      if (Item !== undefined) throw error;
    }
  }

  async rejectedDispatches(session: SessionPurge, runtimeTarget?: string): Promise<RegisteredDispatch[]> {
    if (runtimeTarget === undefined) return [];
    const rows = await this.queryPartition(dispatchKey(session, '').pk) as unknown as {
      sk: string; rejected_runtime_binding?: string; rejected_runtime_target?: string; runtime_stop_confirmed?: string; writer_control?: 'runtime' | 'session-post';
    }[];
    return rows.filter((row) => row.rejected_runtime_binding === session.session_id && row.rejected_runtime_target === runtimeTarget)
      .map((row) => this.acknowledgement(session, row.sk, true, row.runtime_stop_confirmed === session.session_id, runtimeTarget, row.writer_control));
  }

  async settlePostedWriter(session: SessionPurge, token: string): Promise<void> {
    const kind = 'session-post';
    if (!WRITER_TOKEN.test(token)) throw new SessionDispatchPendingError('Successful writer identity is unproved');
    const Key = dispatchKey(session, token);
    const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
    if (Item === undefined) return;
    if (Item.session_id !== session.session_id || Item.filing_user_id !== session.filing_user_id || Item.writer_succeeded !== kind) {
      throw new SessionDispatchPendingError('Successful writer settlement is unproved');
    }
    await this.settleRegistration(session, token,
      'session_id = :session AND filing_user_id = :filing AND writer_succeeded = :kind',
      { ':session': session.session_id, ':filing': session.filing_user_id, ':kind': kind },
      Item.writer_control as 'runtime' | 'session-post' | undefined);

  }

  private async acknowledgeSuccessfulWriters(session: SessionPurge, pk: string): Promise<void> {
    const rows = await this.queryPartition(pk);
    await Promise.all(rows.filter((row) =>
      row.writer_succeeded === 'session-post' &&
      row.session_id === session.session_id && row.filing_user_id === session.filing_user_id &&
      WRITER_TOKEN.test(row.sk)
    ).map((row) => this.settlePostedWriter(session, row.sk)));
  }

  async stopAfterWriters(session: SessionPurge, upstream: WriterStop, local: boolean): Promise<void | 'absent'> {
    upstream.fence([session]);
    await this.settleExpired(session);
    if (local) await upstream.stop(session);
    const rejected = await this.rejectedDispatches(session, upstream.runtimeTarget);
    await this.assertNoDispatch(session, rejected.flatMap(({ token }) => token === undefined ? [] : [token]));
    if (rejected.length > 0) {
      await recoverRejectedWriters(session, rejected, upstream.stopRejectedWriter);
      await this.assertNoDispatch(session);
    } else if (!local) return upstream.stop(session);
  }

  async runPost(
    register: () => Promise<WriterLease>, wait: WriterWait, store: ScheduledRunStore, delivery: ScheduledDelivery,
    outcome: { failed: boolean; status: ScheduledTaskRun['status'] | undefined },
    post: (session: SessionPurge, expiresAt: number) => Promise<unknown>,
  ): Promise<ScheduledDelivery> {
    const lease: RegisteredDispatch = await acquire(register, wait);
    const { session, token, postLeaseExpiresAt, markSucceeded } = lease;
    if (session === undefined || token === undefined || postLeaseExpiresAt === undefined || markSucceeded === undefined) {
      throw new HttpError(503, 'Scheduled post registration is unavailable');
    }
    let submitted = false;
    let posting: ScheduledDelivery;
    try {
      posting = await store.posting(delivery, { session, token }, postingProof(this.tableName, session, token), outcome.failed, outcome.status);
      submitted = true;
      await post(session, postLeaseExpiresAt);
      await markSucceeded('session-post', store.postedTransaction(posting));
    } catch (error) {
      // Retain the dispatch row because Lambda may still be writing.
      await (submitted ? this.unlockPost(session, token) : this.abandonPost(session, token)).catch((releaseError: unknown) => {
        throw new AggregateError([error, releaseError], 'Scheduled post failed and its lease could not be released');
      });
      throw error;
    }
    await lease();
    return posting;
  }

  private async unlockPost(session: SessionPurge, token: string): Promise<void> {
    try {
      await this.documents.send(new UpdateCommand(this.releasePostLease(session, token).Update));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  private async abandonPost(session: SessionPurge, token: string): Promise<void> {
    await this.documents.send(new TransactWriteCommand({ TransactItems: [
      this.releasePostLease(session, token),
      { Delete: { TableName: this.tableName, Key: dispatchKey(session, token) } },
    ] }));
  }

  private releasePostLease(session: SessionPurge, token: string) {
    return { Update: {
      TableName: this.tableName, Key: writerControlKey(session), UpdateExpression: 'REMOVE external_token, lease_expires_at',
      ConditionExpression: 'external_token = :token', ExpressionAttributeValues: { ':token': token },
    } };
  }

  async settleExpired(session: SessionPurge, now = Date.now(), runtimeOnly = false): Promise<boolean> {
    const expired = (await this.queryPartition(dispatchKey(session, '').pk))
      .filter((item) => (!runtimeOnly || item.writer_control === 'runtime') &&
        registrationExpired(String(item.created_at), now) && item.writer_succeeded !== 'session-post');
    for (const item of expired) {
      const kind = item.writer_control === 'runtime' || item.writer_control === 'session-post' ? item.writer_control : undefined;
      // eslint-disable-next-line no-await-in-loop -- archive each registration before rechecking
      await this.archiveExpired(session, item.sk, String(item.created_at), kind);
    }
    return expired.length > 0;
  }

  private async archiveExpired(session: SessionPurge, token: string, created: string, kind?: 'runtime' | 'session-post'): Promise<void> {
    console.info(`Dispatch registration expired. session_id=${session.session_id} registration=${token} created_at=${created}`);
    await this.settleRegistration(session, token, 'created_at = :created AND attribute_not_exists(writer_succeeded)', { ':created': created }, kind, true);
  }

  async assertNoDispatch(session: SessionPurge, failedAdmissionTokens: readonly string[] = []): Promise<void> {
    const current = dispatchKey(session, '').pk;
    await this.acknowledgeSuccessfulWriters(session, current);
    // Older tasks register under the public Session ID.
    for (const pk of [current, `DISPATCH#${session.session_id}`]) {
      // eslint-disable-next-line no-await-in-loop -- check both registry generations
      const items: { sk: string; dispatcher?: string }[] = await this.queryPartition(pk);
      const pending = items.find((item) => pk !== current || !failedAdmissionTokens.includes(item.sk));
      if (pending !== undefined) throw new SessionDispatchPendingError(`Session dispatch is still registered; deletion is blocked. session_id=${session.session_id} filing_user_id=${session.filing_user_id} registration=${String(pending.sk)} dispatcher=${String(pending.dispatcher)}`);
    }
  }

  private async queryPartition(pk: string): Promise<WriterItem[]> {
    const items: WriterItem[] = [];
    const pages = paginateQuery({ client: this.documents }, {
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ConsistentRead: true,
    });
    for await (const page of pages) items.push(...(page.Items as WriterItem[]));
    return items;
  }
}

async function recoverRejectedWriters(
  session: SessionPurge, rejected: readonly RegisteredDispatch[], stop: (session: SessionPurge) => Promise<void>,
): Promise<void> {
  if (!rejected.every((writer) => writer.stopConfirmed === true)) await stop(session);
  await Promise.all(rejected.map(async (writer) => { await writer.confirmStopped?.(); }));
  await Promise.all(rejected.map((writer) => writer()));
}
