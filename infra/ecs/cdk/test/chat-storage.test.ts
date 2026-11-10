import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ChatStorageStack } from '../lib/chat-storage-stack.js';

const storage = () => Template.fromStack(new ChatStorageStack(new App(), 'TestChat', {}));

test('chat history is protected, backed up and retained with quota-only TTL', () => {
  const template = storage();
  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      TableName: 'chat',
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      TimeToLiveSpecification: { AttributeName: 'turnQuotaExpiresAt', Enabled: true },
    },
  });
});

test('retired S3 Files resources and sync permissions are absent', () => {
  const template = storage();
  for (const type of ['AWS::S3::Bucket', 'AWS::S3Files::FileSystem', 'AWS::IAM::Role']) template.resourceCountIs(type, 0);
});

test("every account's Files can live on one retained, encrypted, backed-up EFS file system that only IAM over TLS mounts", () => {
  const template = storage();
  template.hasResource('AWS::EFS::FileSystem', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      Encrypted: true,
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'elastic',
      BackupPolicy: { Status: 'ENABLED' },
      FileSystemPolicy: { Statement: [{
        Effect: 'Allow',
        Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':root']] } },
        // No ClientRootAccess: every mount goes through an account's access point as uid 1000.
        Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        Condition: { Bool: { 'aws:SecureTransport': 'true', 'elasticfilesystem:AccessedViaMountTarget': 'true' } },
      }] },
    },
  });
});

test('adopter table names reach durable storage', () => {
  const template = Template.fromStack(new ChatStorageStack(new App(), 'Named', { tableName: 'adopter-chat' }));
  template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'adopter-chat' });
});

test('adopter tables are reused without creating one', () => {
  const app = new App();
  const references = new Stack(app, 'References');
  const table = Table.fromTableName(references, 'Table', 'existing-chat');
  const storage = new ChatStorageStack(app, 'Reused', { chatTable: table });
  Template.fromStack(storage).resourceCountIs('AWS::DynamoDB::Table', 0);
  expect(storage.chatTable.tableName).toBe('existing-chat');
  expect(() => new ChatStorageStack(app, 'Ambiguous', { chatTable: table, tableName: 'replacement' })).toThrow('chatTable and tableName');
});
