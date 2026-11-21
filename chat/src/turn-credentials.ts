import { randomUUID } from 'node:crypto';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { turnScope, type TurnIdentitySource, type TurnGrant, type TurnIdentityClaims, type TurnScope } from './turn-identity.js';

/** STS refuses an inline session policy longer than this many characters. */
export const SESSION_POLICY_LIMIT = 2048;
const LIFETIME_SECONDS = 3600;
// Wildcards and no Sids keep the longest IDs under the limit; of the role's actions, these match exactly its four
// event actions, its four record actions, and of those ListMemoryRecords and RetrieveMemoryRecords.
const EVENTS = 'bedrock-agentcore:*Event*';
const RECORDS = 'bedrock-agentcore:*MemoryRecord*';
const RECORD_LISTS = 'bedrock-agentcore:*MemoryRecords';

/**
 * The Memory role's statements with the Turn's values written in, as the session policy of an `AssumeRole`:
 * the role names the Memory, and the credentials hold only what both allow.
 */
export function memorySessionPolicy(scope: TurnScope): string {
  const allow = (Action: string | string[], Condition?: Record<string, Record<string, string | string[]>>) =>
    ({ Effect: 'Allow', Action, Resource: '*', ...(Condition ? { Condition } : {}) });
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      allow(EVENTS, {
        StringEquals: { 'bedrock-agentcore:actorId': scope.filingActorId },
        StringLike: { 'bedrock-agentcore:sessionId': [scope.sessionId, `${scope.writesPrefix}-*`] },
      }),
      allow(EVENTS, { StringEquals: { 'bedrock-agentcore:actorId': scope.actorId } }),
      // GetMemoryRecord and DeleteMemoryRecord take bedrock-agentcore:namespace too (AWS Service Authorization Reference).
      allow(RECORDS, { StringLike: { 'bedrock-agentcore:namespace': `/actors/${scope.actorId}/*` } }),
      allow(RECORD_LISTS, { StringLike: { 'bedrock-agentcore:namespacePath': `/actors/${scope.actorId}/*` } }),
    ],
  });
  if (policy.length > SESSION_POLICY_LIMIT) {
    throw new Error(`The Turn's Memory session policy is ${policy.length} characters; STS takes at most ${SESSION_POLICY_LIMIT}`);
  }
  return policy;
}

/** The `assume-role` Turn credentials adapter: the Chat Service assumes the Memory role for each Turn, scoped by a session policy. */
export function assumeRoleAwsAccess(roleArn: string, sts = new STSClient({})): TurnIdentitySource {
  return {
    async grant(turn: TurnIdentityClaims): Promise<TurnGrant> {
      const scope = turnScope(turn);
      const turnId = randomUUID();
      const { Credentials: issued } = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `turn-${turnId}`,
        DurationSeconds: LIFETIME_SECONDS,
        Policy: memorySessionPolicy(scope),
      }));
      const { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken, Expiration: expiration } = issued ?? {};
      if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new Error('STS AssumeRole answered no credentials for Memory');
      return {
        forwarded: { ...scope, turnId, accessKeyId, secretAccessKey, sessionToken, expiration: expiration.toISOString() },
        secrets: [secretAccessKey, sessionToken],
      };
    },
  };
}
