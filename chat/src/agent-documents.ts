import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { HttpError, type AgentDocumentSet, type AgentIdentity } from './cartridge.js';
import { ownerFenceKey } from './session-metadata.js';
import { pictureFromItem, pictureItem, type Picture } from './pictures.js';

/** The CUSTOM event the Harness streams when the agent edits one of its documents. */
export const AGENT_DOCUMENT_EDITED = 'botcube:agent-document-edited';

export type AgentDocumentEdit = { document: 'agentIdentity'; content: AgentIdentity } | { document: 'soul'; content: string };

const IDENTITY_FIELDS = ['name', 'character', 'vibe', 'avatar'] as const;

/** The Agent Identity in this value, or a 422 naming what is wrong with it. */
export function agentIdentity(value: unknown): AgentIdentity {
  const fields = (value ?? {}) as Record<string, unknown>;
  for (const field of IDENTITY_FIELDS) {
    if (typeof fields[field] !== 'string') throw new HttpError(422, `Agent Identity ${field} must be a string`);
  }
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, fields[field]])) as unknown as AgentIdentity;
  if (!identity.name.trim()) throw new HttpError(422, 'Agent Identity name must not be blank');
  return identity;
}

/** The Soul text in this value, or a 422. */
export function soul(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(422, 'Soul content must be a string');
  return value;
}

/** The edit an agent-document-edited event carries, or a 422 naming what is wrong with it. */
export function agentDocumentEdit(value: unknown): AgentDocumentEdit {
  const { document, content } = (value ?? {}) as Record<string, unknown>;
  if (document === 'agentIdentity') return { document, content: agentIdentity(content) };
  if (document === 'soul') return { document, content: soul(content) };
  throw new HttpError(422, 'The edit names no agent document');
}

/** The text of an edited Memory line, or a 422. */
export function memoryLine(value: unknown): string {
  const { text } = (value ?? {}) as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(422, 'A Memory line must be non-blank text');
  return text;
}

/**
 * An account's Agent Identity and Soul, and its Memory cache generation: how many times the user
 * invalidates Memory, so the Harness reads Memory afresh after an edit or deletion retry.
 */
export type AccountAgentDocuments = AgentDocumentSet & { memoryRevision: number };

/** Per-account Agent Identity and Soul, each falling back to the Cartridge's template until edited. */
export interface AgentDocuments {
  get(owner: string, templates: AgentDocumentSet): Promise<AccountAgentDocuments>;
  save(owner: string, edit: AgentDocumentEdit): Promise<void>;
  /** Invalidate cached Memory after an edit or a deletion that finds the line absent. */
  memoryEdited(owner: string): Promise<void>;
  /** The agent's picture, or null while its avatar is an emoji or initial. */
  picture(owner: string): Promise<Picture | null>;
  /** Keep this picture as the agent's, or clear it with null. */
  savePicture(owner: string, picture: Picture | null): Promise<void>;
  /** Delete the account's documents and picture. */
  delete(owner: string): Promise<void>;
}

const ATTRIBUTE = { agentIdentity: 'agent_identity', soul: 'soul', memoryRevision: 'memory_revision' } as const;
const key = (owner: string, sk = 'DOCUMENTS') => ({ pk: `AGENT#${owner}`, sk });
const pictureKey = (owner: string) => key(owner, 'PICTURE');

/**
 * Agent documents in the Chat Service's table, `pk = AGENT#<owner>`: the documents in `sk = DOCUMENTS`,
 * and the agent's picture in its own `sk = PICTURE` item, so a Turn never reads it.
 */
export class DynamoDBAgentDocuments implements AgentDocuments {
  private readonly documents: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client = new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
  ) {
    this.documents = DynamoDBDocumentClient.from(client);
  }

  async get(owner: string, templates: AgentDocumentSet): Promise<AccountAgentDocuments> {
    const { Item } = await this.documents.send(
      // Stryker disable next-line BooleanLiteral: a read right after a save must see it, which only a live DynamoDB can fail to do
      new GetCommand({ TableName: this.tableName, Key: key(owner), ConsistentRead: true }),
    );
    return {
      agentIdentity: (Item?.[ATTRIBUTE.agentIdentity] as AgentIdentity | undefined) ?? templates.agentIdentity,
      soul: (Item?.[ATTRIBUTE.soul] as string | undefined) ?? templates.soul,
      memoryRevision: (Item?.[ATTRIBUTE.memoryRevision] as number | undefined) ?? 0,
    };
  }

  async memoryEdited(owner: string): Promise<void> {
    await this.documents.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key(owner),
        UpdateExpression: 'ADD #revision :one',
        ExpressionAttributeNames: { '#revision': ATTRIBUTE.memoryRevision },
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  }

  async save(owner: string, edit: AgentDocumentEdit): Promise<void> {
    await this.writeForOwner(owner, {
      Update: {
        TableName: this.tableName,
        Key: key(owner),
        UpdateExpression: 'SET #document = :content',
        ExpressionAttributeNames: { '#document': ATTRIBUTE[edit.document] },
        ExpressionAttributeValues: { ':content': edit.content },
      },
    });
  }

  async picture(owner: string): Promise<Picture | null> {
    const { Item } = await this.documents.send(
      // Stryker disable next-line BooleanLiteral: a read right after a save must see it, which only a live DynamoDB can fail to do
      new GetCommand({ TableName: this.tableName, Key: pictureKey(owner), ConsistentRead: true }),
    );
    return pictureFromItem(Item);
  }

  async savePicture(owner: string, picture: Picture | null): Promise<void> {
    if (picture === null) {
      await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key: pictureKey(owner) }));
      return;
    }
    await this.writeForOwner(owner, { Put: { TableName: this.tableName, Item: { ...pictureKey(owner), ...pictureItem(picture) } } });
  }

  private async writeForOwner(owner: string, write: NonNullable<TransactWriteCommandInput['TransactItems']>[number]): Promise<void> {
    try {
      await this.documents.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: ownerFenceKey(owner),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            write,
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        throw Object.assign(new HttpError(409, 'Account history is deleted'), { cause: error });
      }
      throw error;
    }
  }

  async delete(owner: string): Promise<void> {
    await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key: key(owner) }));
    await this.savePicture(owner, null);
  }
}
