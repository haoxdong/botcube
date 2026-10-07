import { App } from 'aws-cdk-lib';
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
