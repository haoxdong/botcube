import { createHash } from 'node:crypto';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './cartridge.js';

export interface TurnQuotaLimits {
  anonymous: number;
  claimed: number;
  ip: number;
}

const DEFAULT_LIMITS: TurnQuotaLimits = { anonymous: 10, claimed: 30, ip: 60 };

export class TurnQuotaExceeded extends HttpError {
  constructor(readonly retryAfter: number) {
    super(429, 'Turn limit reached. Try again after the current minute.', 'TURN_QUOTA_EXCEEDED');
  }
}

/** Both counters advance together across Chat Service tasks; TTL is cleanup, never admission. */
export class TurnQuota {
  private readonly documents: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
    private readonly limits: TurnQuotaLimits = DEFAULT_LIMITS,
  ) {
    for (const limit of Object.values(limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Turn quotas must be positive integers');
    }
    this.documents = DynamoDBDocumentClient.from(client);
  }

  async admit(owner: string, ip: string | undefined, claimed = false): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / 60);
    const expiresAt = (window + 1) * 60;
    const counters = [{ kind: 'account', identity: owner, limit: claimed ? this.limits.claimed : this.limits.anonymous }];
    if (ip) counters.push({ kind: 'ip', identity: ip, limit: this.limits.ip });
    try {
      await this.documents.send(new TransactWriteCommand({
        TransactItems: counters.map(({ kind, identity, limit }) => ({ Update: {
          TableName: this.table,
          Key: { pk: `TURN_QUOTA#${kind}#${createHash('sha256').update(identity).digest('hex')}`, sk: String(window) },
          UpdateExpression: 'SET turnQuotaExpiresAt = :expires ADD #count :one',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: { ':expires': expiresAt, ':one': 1, ':limit': limit },
        } })),
      }));
    } catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.some(({ Code }) => Code === 'ConditionalCheckFailed')) {
        throw new TurnQuotaExceeded(expiresAt - now);
      }
      const failure = new HttpError(503, 'Turn quota storage is unavailable', 'TURN_QUOTA_UNAVAILABLE');
      failure.cause = error;
      throw failure;
    }
  }
}
