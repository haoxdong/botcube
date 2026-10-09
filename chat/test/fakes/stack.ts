import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from './credentials.js';
export { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from './credentials.js';
export const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/parity-suite';

export async function createChatTable(endpoint: string, table: string, closed = true): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'DynamoDB_20120810.CreateTable',
      authorization: `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=0`,
    },
    body: JSON.stringify({
      TableName: table,
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  });
  if (response.status !== 200) {
    throw new Error(`CreateTable ${table}: ${response.status} ${await response.text()}`);
  }
  if (closed) await createRuntimeNamespaceReady(endpoint, table);
}

async function createRuntimeNamespaceReady(endpoint: string, table: string): Promise<void> {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({
    endpoint, region: 'us-east-1',
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  }));
  await client.send(new PutCommand({
    TableName: table, Item: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED', old_chat_retired: true, memory_broker_only: true },
  }));
}


