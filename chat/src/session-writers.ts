import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand, paginateQuery, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { SessionPurge } from './session-identity.js';

/** A registered writer has not acknowledged dispatch/completion yet; deletion must keep waiting. */
export class SessionDispatchPendingError extends Error {}
export class SessionWriterRecoveryError extends Error {}

export type RegisteredDispatch = (() => Promise<void>) & {
  readonly session?: SessionPurge;
  readonly token?: string;
  readonly snapshotEpoch?: string;
  abortUnsubmitted?: () => Promise<void>;
  markRejected?: (runtimeTarget: string) => Promise<void>;
  markSucceeded?: (kind: 'session-post', completion?: NonNullable<TransactWriteCommandInput['TransactItems']>[number]) => Promise<void>;
  confirmStopped?: () => Promise<void>;
  stopConfirmed?: boolean;
};

export type RegisteredSessionDispatch = RegisteredDispatch & { readonly session: SessionPurge };
const dispatcherId = `${hostname()}:${process.pid}:${randomUUID()}`;

/**
 * A registration this old is settled. AgentCore ends every Sandbox at MaxLifetime (3600 s, ADR 0029), and
 * 2 h more covers the one-hour task drain and the stop timeout, so nothing it admitted can still write
 * (the maintainer's decision, 2026-11-04). A younger registration still needs its exact stop.
 */
export const REGISTRATION_EXPIRY_MS = 3 * 3_600_000;
const dispatchKey = ({ session_id, filing_user_id }: SessionPurge, token: string) => ({ pk: `DISPATCH#${JSON.stringify([filing_user_id, session_id])}`, sk: token });

export const writerControlKey = ({ session_id, filing_user_id }: SessionPurge) => ({ pk: `WRITERS#${JSON.stringify([filing_user_id, session_id])}`, sk: 'CONTROL' });
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type WriterItem = { pk: string; sk: string; dispatcher?: string } & Record<string, unknown>;

export class SessionWriters {
  constructor(private readonly tableName: string, private readonly documents: DynamoDBDocumentClient) {}

  /** The writer's registration and its count on the Session's writer control; a scheduled post holds the control exclusively. */
  registration(session: SessionPurge, token: string, kind: 'runtime' | 'session-post', rejectedCount = 0): [TransactItem, TransactItem] {
    return [
      { Put: { TableName: this.tableName, Item: { ...dispatchKey(session, token), ...session, writer_control: kind, dispatcher: dispatcherId, created_at: new Date().toISOString().replace('Z', '000+00:00') } } },
      { Update: {
        TableName: this.tableName, Key: writerControlKey(session),
        UpdateExpression: kind === 'runtime' ? 'ADD runtime_writers :one' : 'SET external_token = :token',
        ConditionExpression: 'attribute_not_exists(external_token)' + (kind === 'runtime' ? '' : rejectedCount === 0 ? ' AND (attribute_not_exists(runtime_writers) OR runtime_writers = :zero)' : ' AND runtime_writers = :zero'),
        ExpressionAttributeValues: kind === 'runtime' ? { ':one': 1 } : { ':token': token, ':zero': rejectedCount },
      } },
    ];
  }

  recoveryConditions(session: SessionPurge, target: string, registrations: readonly RegisteredDispatch[]): TransactItem[] {
    return registrations.map(({ token }) => {
      if (token === undefined) throw new SessionDispatchPendingError('Rejected writer identity is unproved');
      return { ConditionCheck: {
      TableName: this.tableName, Key: dispatchKey(session, token),
      ConditionExpression: 'writer_control = :kind AND rejected_runtime_binding = :binding AND rejected_runtime_target = :target',
      ExpressionAttributeValues: { ':kind': 'runtime', ':binding': session.session_id, ':target': target },
      } };
    });
  }

  acknowledgement(session: SessionPurge, token: string, recovered = false, stopped = false, runtimeTarget?: string, writerKind?: 'runtime' | 'session-post', snapshotEpoch?: string): RegisteredSessionDispatch {
    const Key = dispatchKey(session, token);
    // A rejected admission is recorded against the Sandbox it may have started, which is the Session ID.
    const binding = { ':binding': session.session_id };
    const complete: RegisteredSessionDispatch = Object.assign(async () => {
      const condition = recovered
        ? 'rejected_runtime_binding = :binding AND rejected_runtime_target = :target AND runtime_stop_confirmed = :binding'
        : 'attribute_exists(pk)' + (writerKind === 'session-post' ? ' AND writer_succeeded = :kind' : '');
      const values = recovered ? { ...binding, ':target': runtimeTarget } : writerKind === 'session-post' ? { ':kind': 'session-post' } : writerKind === 'runtime' ? binding : undefined;
      await this.settleRegistration(session, token, condition + (!recovered && writerKind === 'runtime' ? ' AND (attribute_not_exists(rejected_runtime_binding) OR runtime_stop_confirmed = :binding)' : ''), values, writerKind, false, recovered);
    }, { session, token, stopConfirmed: stopped, ...(snapshotEpoch === undefined ? {} : { snapshotEpoch }) });
    if (writerKind === 'session-post') complete.abortUnsubmitted = () => this.settleRegistration(session, token,
      'dispatcher = :dispatcher AND attribute_not_exists(writer_succeeded)', { ':dispatcher': dispatcherId }, writerKind, true);
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
          ...(writerKind === 'session-post' ? [{ Update: {
            TableName: this.tableName, Key: writerControlKey(session), UpdateExpression: 'REMOVE external_token',
            ConditionExpression: 'external_token = :token', ExpressionAttributeValues: { ':token': token },
          } }] : []),
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

  private async settleRegistration(session: SessionPurge, token: string, condition: string, values: Record<string, unknown> | undefined, kind?: 'runtime' | 'session-post', abortUnsubmitted = false, archive = false): Promise<void> {
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
        ...(abortUnsubmitted ? [{ Update: {
          TableName: this.tableName, Key: writerControlKey(session), UpdateExpression: 'REMOVE external_token',
          ConditionExpression: 'external_token = :token', ExpressionAttributeValues: { ':token': token },
        } }] : []),
      ] }));
    } catch (error) {
      if (!(error as Partial<TransactionCanceledException>).CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) throw error;
      const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
      if (Item !== undefined) throw new SessionDispatchPendingError('Writer completion is unproved', { cause: error });
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

  async acknowledgeSuccessfulDispatch(session: SessionPurge, token: string, kind: 'session-post'): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) throw new SessionDispatchPendingError('Successful writer identity is unproved');
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
    const rows = await this.queryPartition(pk) as unknown as {
      sk: string; session_id?: string; filing_user_id?: string; writer_succeeded?: string;
    }[];
    await Promise.all(rows.filter((row) =>
      row.writer_succeeded === 'session-post' &&
      row.session_id === session.session_id && row.filing_user_id === session.filing_user_id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.sk)
    ).map((row) => this.acknowledgeSuccessfulDispatch(session, row.sk, 'session-post')));
  }

  /** Archive and release every registration of `session` older than REGISTRATION_EXPIRY_MS. */
  async settleExpired(session: SessionPurge, now = Date.now()): Promise<void> {
    for (const item of await this.queryPartition(dispatchKey(session, '').pk)) {
      const created = String(item.created_at);
      // A registration whose age is unreadable never expires.
      if (!(now - Date.parse(created) >= REGISTRATION_EXPIRY_MS)) continue;
      const kind = item.writer_control === 'runtime' || item.writer_control === 'session-post' ? item.writer_control : undefined;
      console.info(`Dispatch registration is older than MaxLifetime + 2 h, so it counts as settled. session_id=${session.session_id} registration=${item.sk} dispatcher=${String(item.dispatcher)} created_at=${created}`);
      // eslint-disable-next-line no-await-in-loop -- each expired registration is archived before the purge rechecks the rest
      await this.settleRegistration(session, item.sk, 'created_at = :created', { ':created': created }, kind, kind === 'session-post', true);
    }
  }

  async assertNoDispatch(session: SessionPurge, failedAdmissionTokens: readonly string[] = []): Promise<void> {
    await this.acknowledgeSuccessfulWriters(session, dispatchKey(session, '').pk);
    // Older tasks registered only the public Session ID. Until those tasks are
    // quiescent, absence of the new namespaced row cannot prove deletion is safe.
    for (const pk of [dispatchKey(session, '').pk, `DISPATCH#${session.session_id}`]) {
      // eslint-disable-next-line no-await-in-loop -- check both registry generations before allowing purge
      const items: { sk: string; dispatcher?: string }[] = await this.queryPartition(pk);
      const pending = items.find((item) => pk !== dispatchKey(session, '').pk || !failedAdmissionTokens.includes(item.sk));
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
