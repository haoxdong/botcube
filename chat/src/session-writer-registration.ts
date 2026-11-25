import type { CancellationReason } from '@aws-sdk/client-dynamodb';
import { SessionBusyError } from './session-writer-runtime.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { TransactionWrite } from './named-transaction.js';
import type { SessionPurge } from './session-identity.js';

export const dispatcherId = `${hostname()}:${process.pid}:${randomUUID()}`;

export const dispatchKey = ({ session_id, filing_user_id }: SessionPurge, token: string) => ({ pk: `DISPATCH#${JSON.stringify([filing_user_id, session_id])}`, sk: token });

export const writerControlKey = ({ session_id, filing_user_id }: SessionPurge) => ({ pk: `WRITERS#${JSON.stringify([filing_user_id, session_id])}`, sk: 'CONTROL' });
export const POST_LEASE_AVAILABLE = '(attribute_not_exists(external_token) OR lease_expires_at < :now)';

export function registerWriter(TableName: string, session: SessionPurge, token: string, now = Date.now(), postLeaseExpiresAt?: number, rejectedCount = 0): [TransactionWrite, TransactionWrite] {
  return [
    { Put: { TableName, Item: { ...dispatchKey(session, token), ...session, writer_control: postLeaseExpiresAt === undefined ? 'runtime' : 'session-post', dispatcher: dispatcherId, created_at: new Date(now).toISOString().replace('Z', '000+00:00') } } },
    { Update: {
      TableName, Key: writerControlKey(session),
      UpdateExpression: postLeaseExpiresAt === undefined
        ? 'REMOVE external_token, lease_expires_at ADD runtime_writers :one'
        : 'SET external_token = :token, lease_expires_at = :expiry',
      ConditionExpression: POST_LEASE_AVAILABLE + (postLeaseExpiresAt === undefined ? '' : rejectedCount === 0 ? ' AND (attribute_not_exists(runtime_writers) OR runtime_writers = :zero)' : ' AND runtime_writers = :zero'),
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      ExpressionAttributeValues: postLeaseExpiresAt === undefined ? { ':one': 1, ':now': now } : { ':token': token, ':zero': rejectedCount, ':now': now, ':expiry': postLeaseExpiresAt },
    } },
  ];
}

export function postingProof(TableName: string, session: SessionPurge, token: string): TransactionWrite {
  return { ConditionCheck: {
    TableName, Key: dispatchKey(session, token),
    ConditionExpression: 'session_id = :session AND filing_user_id = :filing',
    ExpressionAttributeValues: { ':session': session.session_id, ':filing': session.filing_user_id },
  } };
}

export function writerBusy({ Item }: CancellationReason, expiresAfter: number): SessionBusyError {
  const token = Item?.external_token?.S;
  const expiry = Number(Item?.lease_expires_at?.N);
  return new SessionBusyError('Session persistence writer is still active', token === undefined ? undefined : {
    token, createdAt: Number.isFinite(expiry) ? new Date(expiry - expiresAfter).toISOString() : 'unknown',
  });
}

export function recoveryConditions(TableName: string, session: SessionPurge, target: string, tokens: readonly string[]): TransactionWrite[] {
  return tokens.map((token) => ({ ConditionCheck: {
    TableName, Key: dispatchKey(session, token),
    ConditionExpression: 'writer_control = :kind AND rejected_runtime_binding = :binding AND rejected_runtime_target = :target',
    ExpressionAttributeValues: { ':kind': 'runtime', ':binding': session.session_id, ':target': target },
  } }));
}
