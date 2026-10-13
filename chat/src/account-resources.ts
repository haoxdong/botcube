import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
export class AccountStoreError extends Error {}
export interface AgentComputerRecord { profileId: string | null; }
type Item = Record<string, unknown>;
const key = (pk: string, sk = 'META') => ({ pk, sk });
/** The account's browser profiles, screenshots, and Files access points. */
export class AccountResources {
  constructor(
    readonly tableName: string,
    readonly documents: Pick<DynamoDBDocumentClient, 'send'> = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
    ),
  ) {}

  /** Send a DynamoDB command; a failure is an AccountStoreError naming the DynamoDB operation. */
  async call<T>(operation: string, command: { input: object }): Promise<T> {
    try {
      return (await this.documents.send(command as never)) as T;
    } catch (error) {
      throw new AccountStoreError(`DynamoDB account storage ${operation} failed`, { cause: error });
    }
  }

  protected async get(pk: string, sk = 'META'): Promise<Item | undefined> {
    const { Item } = await this.call<{ Item?: Item }>(
      'GetItem',
      new GetCommand({ TableName: this.tableName, Key: key(pk, sk), ConsistentRead: true }),
    );
    return Item;
  }

  async agentComputer(accountId: string): Promise<AgentComputerRecord> {
    const item = await this.get(`AGENT_COMPUTER#${accountId}`);
    return item === undefined ? { profileId: null } : { profileId: (item.record as AgentComputerRecord).profileId };
  }

  /** The Session's last Agent Computer screen, a JPEG data URL, once its browser has slept. */
  async agentComputerScreenshot(accountId: string, threadId: string): Promise<string | null> {
    const item = await this.get(`AGENT_COMPUTER#${accountId}`, `SCREENSHOT#${threadId}`);
    return typeof item?.screenshot === 'string' ? item.screenshot : null;
  }

  /** Last writer wins, as for the Agent Computer's record. */
  async saveAgentComputerScreenshot(accountId: string, threadId: string, screenshot: string): Promise<void> {
    await this.call(
      'PutItem',
      new PutCommand({
        TableName: this.tableName,
        Item: { ...key(`AGENT_COMPUTER#${accountId}`, `SCREENSHOT#${threadId}`), screenshot },
      }),
    );
  }

  /** Last writer wins: an Agent Computer's record is no account state, so no lease fences it. */
  async saveAgentComputer(accountId: string, record: AgentComputerRecord): Promise<void> {
    await this.call(
      'PutItem',
      new PutCommand({ TableName: this.tableName, Item: { ...key(`AGENT_COMPUTER#${accountId}`), record } }),
    );
  }

  async deleteAgentComputer(accountId: string): Promise<void> {
    const pk = `AGENT_COMPUTER#${accountId}`;
    let exclusiveStartKey: Item | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- pagination: each page starts after the previous page's LastEvaluatedKey
      const page = await this.call<{ Items?: Item[]; LastEvaluatedKey?: Item }>(
        'Query',
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': 'SCREENSHOT#' },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) {
        // eslint-disable-next-line no-await-in-loop -- one screenshot at a time: a retried deletion removes what is left
        await this.call('DeleteItem', new DeleteCommand({ TableName: this.tableName, Key: key(pk, item.sk as string) }));
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    await this.call('DeleteItem', new DeleteCommand({ TableName: this.tableName, Key: key(pk) }));
  }

  /** The S3 Files access point of the account's Files, once created. */
  async filesAccessPoint(accountId: string): Promise<string | null> {
    const item = await this.get(`FILES#${accountId}`);
    return typeof item?.accessPointArn === 'string' ? item.accessPointArn : null;
  }

  /** Forget the account's Files access point once it is deleted. */
  async deleteFilesAccessPoint(accountId: string): Promise<void> {
    await this.call('DeleteItem', new DeleteCommand({ TableName: this.tableName, Key: key(`FILES#${accountId}`) }));
  }

  /** Concurrent creations made the same access point, so the last writer stores what the first did. */
  async saveFilesAccessPoint(accountId: string, accessPointArn: string): Promise<void> {
    await this.call(
      'PutItem',
      new PutCommand({ TableName: this.tableName, Item: { ...key(`FILES#${accountId}`), accessPointArn } }),
    );
  }

}
/** The ChatGPT identity is another account's OpenAI Sign-in. */
export class OpenAIIdentityTaken extends AccountStoreError {
  constructor() {
    super('This ChatGPT identity already gives another Account Plan Usage');
  }
}
