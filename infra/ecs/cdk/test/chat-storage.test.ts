import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ChatStorageStack } from '../lib/chat-storage-stack.js';

const storage = () => Template.fromStack(new ChatStorageStack(new App(), 'TestChat', { corsOrigins: ['https://chat.example.com'] }));

test('chat history is protected, backed up and retained without TTL', () => {
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
      TimeToLiveSpecification: Match.absent(),
    },
  });
});

test("every account's Files live in one retained S3 Files file system over a versioned, encrypted, private bucket", () => {
  const template = storage();
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      // The Files app uploads straight to the bucket from the web UI.
      CorsConfiguration: { CorsRules: [{ AllowedOrigins: ['https://chat.example.com'], AllowedMethods: ['PUT'], AllowedHeaders: ['*'] }] },
    },
  });
  const [bucket] = Object.keys(template.findResources('AWS::S3::Bucket'));
  const [role] = Object.keys(template.findResources('AWS::IAM::Role'));
  const [syncPolicy] = Object.keys(template.findResources('AWS::IAM::Policy'));
  template.hasResourceProperties('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
  ]) } });
  // The file system syncs only once its role may reach the bucket.
  template.hasResource('AWS::S3Files::FileSystem', {
    DeletionPolicy: 'Retain',
    DependsOn: Match.arrayWith([syncPolicy]),
    Properties: { Bucket: { 'Fn::GetAtt': [bucket, 'Arn'] }, RoleArn: { 'Fn::GetAtt': [role, 'Arn'] } },
  });
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: { Statement: [{
      Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'elasticfilesystem.amazonaws.com' },
      Condition: {
        StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
        ArnLike: { 'aws:SourceArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3files:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':file-system/*']] } },
      },
    }] },
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Action: Match.arrayWith(['s3:DeleteObject*', 's3:PutObject']) }),
    Match.objectLike({ Action: ['s3:ListBucketVersions', 's3:GetObjectVersion*', 's3:DeleteObjectVersion'] }),
    Match.objectLike({ Action: Match.arrayWith(['events:PutRule']), Condition: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } } }),
  ]) } });
});

test('adopter names reach durable storage and its sync role', () => {
  const template = Template.fromStack(new ChatStorageStack(new App(), 'Named', {
    corsOrigins: [], tableName: 'adopter-chat', filesBucketName: 'adopter-files', filesSyncRoleName: 'adopter-files-sync',
  }));
  template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'adopter-chat' });
  template.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'adopter-files' });
  template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-files-sync' });
});

test('adopter storage is reused without creating a table or bucket', () => {
  const app = new App();
  const references = new Stack(app, 'References', { env: { account: '123456789012', region: 'us-east-1' } });
  const table = Table.fromTableName(references, 'Table', 'existing-chat');
  const bucket = Bucket.fromBucketName(references, 'Bucket', 'existing-files');
  const storage = new ChatStorageStack(app, 'Reused', { env: { account: '123456789012', region: 'us-east-1' }, corsOrigins: [], chatTable: table, filesBucket: bucket });
  const template = Template.fromStack(storage);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
  template.resourceCountIs('AWS::S3::Bucket', 0);
  template.hasResourceProperties('AWS::S3Files::FileSystem', { Bucket: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3:::existing-files']] } });
  expect(storage.chatTable.tableName).toBe('existing-chat');
  expect(() => new ChatStorageStack(app, 'Ambiguous', { corsOrigins: [], chatTable: table, tableName: 'replacement' })).toThrow('chatTable and tableName');
});

test('invalid concrete storage names fail synthesis and imported buckets own their names', () => {
  expect(() => new ChatStorageStack(new App(), 'Invalid', { corsOrigins: [], filesBucketName: 'Invalid Bucket Name' })).toThrow();
  const app = new App();
  const reference = new Stack(app, 'Reference');
  expect(() => new ChatStorageStack(app, 'AmbiguousBucket', { corsOrigins: [], filesBucket: Bucket.fromBucketName(reference, 'Bucket', 'owned-files'), filesBucketName: 'replacement' })).toThrow('filesBucket and filesBucketName');
});
