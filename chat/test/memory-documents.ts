import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { required } from './required.js';

// An in-memory DynamoDB document client for unit tests: one table, and only the
// expression forms the account store writes.

type Item = Record<string, unknown>;
type Values = Record<string, unknown>;
interface Conditional {
  Key?: Item;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Values;
  ExpressionAttributeNames?: Record<string, string>;
}

const metadata = { $metadata: {} };

function clause(item: Item | undefined, text: string, values: Values): boolean {
  const exists = /^attribute_(not_)?exists\((\w+)\)$/.exec(text);
  if (exists) return (item?.[required(exists[2], 'an attribute name')] !== undefined) === (exists[1] === undefined);
  const comparison = /^(\w+) (=|<=|>) (:\w+)$/.exec(text);
  if (!comparison) throw new Error(`Unsupported condition: ${text}`);
  const [, name, operator, placeholder] = comparison;
  const actual = item?.[required(name, 'an attribute name')] as number | string | undefined;
  const expected = values[required(placeholder, 'a placeholder')] as number | string;
  if (actual === undefined) return false;
  if (operator === '=') return actual === expected;
  return operator === '<=' ? actual <= expected : actual > expected;
}

/** `a OR b`, `a AND b` without parentheses. */
const holds = (item: Item | undefined, expression: string | undefined, values: Values = {}) =>
  expression === undefined ||
  expression.split(' OR ').some((alternative) =>
    alternative.split(' AND ').every((part) => clause(item, part.trim(), values)),
  );

export function memoryDocuments(): Pick<DynamoDBDocumentClient, 'send'> & { items: Map<string, Item> } {
  const items = new Map<string, Item>();
  const id = (key: Item) => `${String(key.pk)}\u0000${String(key.sk)}`;
  const check = (key: Item, { ConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames = {} }: Conditional) =>
    holds(items.get(id(key)), ConditionExpression?.replace(/#[A-Za-z0-9_]+/g, (name) => required(ExpressionAttributeNames[name], 'an attribute alias')), ExpressionAttributeValues);

  const writes = {
    Put: (input: { Item: Item } & Conditional) => () => items.set(id(input.Item), structuredClone(input.Item)),
    Delete: (input: { Key: Item } & Conditional) => () => items.delete(id(input.Key)),
    Update: (input: { Key: Item; UpdateExpression: string } & Conditional) => () => {
      const assignment = /^SET (\w+) = (:\w+)$/.exec(input.UpdateExpression);
      if (!assignment) throw new Error(`Unsupported update: ${input.UpdateExpression}`);
      const item = items.get(id(input.Key)) ?? { ...input.Key };
      const values = required(input.ExpressionAttributeValues, 'the update values');
      item[required(assignment[1], 'an attribute name')] = values[required(assignment[2], 'a placeholder')];
      items.set(id(input.Key), item);
    },
    ConditionCheck: () => () => undefined,
  };

  function single(kind: 'Put' | 'Delete' | 'Update', input: Conditional & Item) {
    const key = kind === 'Put' ? (input.Item as Item) : required(input.Key, 'a key');
    if (!check(key, input)) throw new ConditionalCheckFailedException({ message: 'The conditional request failed', ...metadata });
    (writes[kind] as (input: unknown) => () => void)(input)();
    return metadata;
  }

  const send = async (command: { constructor: { name: string }; input: unknown }) => {
    const input = command.input as Conditional & Item;
    switch (command.constructor.name) {
      case 'GetCommand': {
        const item = items.get(id(required(input.Key, 'a key')));
        return { ...metadata, Item: item && structuredClone(item) };
      }
      case 'PutCommand':
        return single('Put', input);
      case 'DeleteCommand':
        return single('Delete', input);
      case 'UpdateCommand':
        return single('Update', input);
      case 'QueryCommand': {
        const values = required(input.ExpressionAttributeValues, 'the query values');
        if (input.KeyConditionExpression !== 'pk = :pk AND begins_with(sk, :prefix)') {
          throw new Error(`Unsupported key condition: ${String(input.KeyConditionExpression)}`);
        }
        const found = [...items.values()]
          .filter((item) => item.pk === values[':pk'] && String(item.sk).startsWith(String(values[':prefix'])))
          .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
        return { ...metadata, Items: structuredClone(found) };
      }
      case 'TransactWriteCommand': {
        const operations = (input.TransactItems as Record<string, Conditional & Item>[]).map((operation) => {
          const [kind, body] = required(Object.entries(operation)[0], 'a transaction operation') as [keyof typeof writes, Conditional & Item];
          const key = kind === 'Put' ? (body.Item as Item) : required(body.Key, 'a key');
          return { ok: check(key, body), apply: (writes[kind] as (input: unknown) => () => void)(body) };
        });
        if (!operations.every(({ ok }) => ok)) {
          throw new TransactionCanceledException({ message: 'Transaction cancelled', ...metadata });
        }
        for (const { apply } of operations) apply();
        return metadata;
      }
      default:
        throw new Error(`Unsupported command: ${command.constructor.name}`);
    }
  };
  return { send: send, items };
}
