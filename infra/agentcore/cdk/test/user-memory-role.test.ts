import { ok as assert } from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import { resolve } from 'path';
import { AgentCoreStack, type AgentCoreStackProps } from '../lib/cdk-stack';
import { agentCoreProjectRoot, readDeployIdentity, readProjectSpec } from '../lib/deploy-config';

const DEPLOY_ROOT = resolve(__dirname, '../../../../examples/public/deploy');
const SPEC = readProjectSpec(DEPLOY_ROOT);
const IDENTITY = readDeployIdentity(DEPLOY_ROOT);
setSessionProjectRoot(agentCoreProjectRoot(readProjectSpec(DEPLOY_ROOT)));

function synthesize(userMemoryRole?: AgentCoreStackProps['userMemoryRole'], existingMemoryKeyArn?: string): Template {
  return Template.fromStack(
    new AgentCoreStack(new cdk.App(), 'UserMemoryRoleStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      spec: SPEC,
      physicalIdentity: {
        runtime: IDENTITY.aws.agentCore.runtime,
        memory: IDENTITY.aws.agentCore.memory,
        sessionApiFunction: IDENTITY.aws.agentCore.sessionApiFunction,
        sessionApiAlias: IDENTITY.aws.agentCore.sessionApiAlias,
        ecrRepository: IDENTITY.aws.ecr.repository,
        codeBuildProject: IDENTITY.aws.codeBuild.project,
        lambdaFunction: IDENTITY.aws.lambda.family,
        roles: {
          memory: IDENTITY.aws.iam.memoryRole,
          lambda: IDENTITY.aws.iam.lambdaRole,
          runtime: IDENTITY.aws.iam.runtimeRole,
          codeBuild: IDENTITY.aws.iam.codeBuildRole,
          sessionApi: IDENTITY.aws.iam.sessionApiRole,
        },
      },
      ...(userMemoryRole ? { userMemoryRole } : {}),
      ...(existingMemoryKeyArn ? { existingMemoryKeyArn } : {}),
    })
  );
}

const template = synthesize({ issuer: 'https://chat.example.com', roleName: 'bot-cube-user-memory' });

function only(type: string): { id: string; properties: Record<string, unknown> } {
  const [entry, ...others] = Object.entries(template.findResources(type));
  assert(entry && others.length === 0, `the stack declares one ${type}`);
  return { id: entry[0], properties: entry[1].Properties };
}

function userMemoryRoleId(): string {
  const [id] = Object.keys(
    template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'bot-cube-user-memory' } })
  );
  assert(id, 'the stack declares the Memory role');
  return id;
}

test("registers the Chat Service's public origin as an OIDC provider for STS's audience", () => {
  expect(only('AWS::IAM::OIDCProvider').properties).toEqual({
    Url: 'https://chat.example.com',
    ClientIdList: ['sts.amazonaws.com'],
  });
});

test('the Memory role trusts only that provider and audience, for tagged web-identity sessions', () => {
  const provider = only('AWS::IAM::OIDCProvider').id;

  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'bot-cube-user-memory',
    MaxSessionDuration: 3600,
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: { Ref: provider } },
          Action: ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession'],
          Condition: { StringEquals: { 'chat.example.com:aud': 'sts.amazonaws.com' } },
        },
      ],
    },
  });
});

test("the Memory role's policy scopes events and records by the session's principal tags", () => {
  const memoryArn = { 'Fn::GetAtt': [only('AWS::BedrockAgentCore::Memory').id, 'MemoryArn'] };
  const events = [
    'bedrock-agentcore:CreateEvent',
    'bedrock-agentcore:GetEvent',
    'bedrock-agentcore:ListEvents',
    'bedrock-agentcore:DeleteEvent',
  ];
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter(policy =>
    policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === userMemoryRoleId())
  );

  expect(policies.flatMap(policy => policy.Properties.PolicyDocument.Statement)).toEqual([
    {
      Sid: 'SessionUnderFilingId',
      Effect: 'Allow',
      Action: events,
      Resource: memoryArn,
      Condition: {
        StringEquals: { 'bedrock-agentcore:actorId': '${aws:PrincipalTag/filingActorId}' },
        StringLike: {
          'bedrock-agentcore:sessionId': ['${aws:PrincipalTag/sessionId}', '${aws:PrincipalTag/writesPrefix}-*'],
        },
      },
    },
    {
      Sid: 'OwnActorEvents',
      Effect: 'Allow',
      Action: events,
      Resource: memoryArn,
      Condition: { StringEquals: { 'bedrock-agentcore:actorId': '${aws:PrincipalTag/actorId}' } },
    },
    {
      Sid: 'OwnRecords',
      Effect: 'Allow',
      Action: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
      Resource: memoryArn,
      Condition: { StringLike: { 'bedrock-agentcore:namespace': '/actors/${aws:PrincipalTag/actorId}/*' } },
    },
    {
      Sid: 'OwnRecordHierarchies',
      Effect: 'Allow',
      Action: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
      Resource: memoryArn,
      Condition: { StringLike: { 'bedrock-agentcore:namespacePath': '/actors/${aws:PrincipalTag/actorId}/*' } },
    },
    {
      // Neither action takes a namespace condition key: an accepted risk (ADR 0031).
      Sid: 'RecordsById',
      Effect: 'Allow',
      Action: ['bedrock-agentcore:GetMemoryRecord', 'bedrock-agentcore:DeleteMemoryRecord'],
      Resource: memoryArn,
    },
  ]);
});

test('outputs the Memory role ARN, and hands it to the Harness', () => {
  const roleArn = { 'Fn::GetAtt': [userMemoryRoleId(), 'Arn'] };

  template.hasOutput('UserMemoryRoleArn', { Value: roleArn });
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({ BOTCUBE_USER_MEMORY_ROLE_ARN: roleArn }),
  });
});

test('declares no OIDC provider or Memory role without an issuer', () => {
  const bare = synthesize();

  bare.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  expect(bare.findResources('AWS::IAM::Role', { Properties: { RoleName: 'bot-cube-user-memory' } })).toEqual({});
});

test('refuses an issuer that is not an https origin', () => {
  for (const issuer of ['http://chat.example.com', 'https://chat.example.com/path', 'https://chat.example.com:8443']) {
    expect(() => synthesize({ issuer, roleName: 'bot-cube-user-memory' })).toThrow(
      'The Memory role issuer must be an https origin without a port'
    );
  }
});

describe('under the assume-role Turn credentials adapter', () => {
  const assumed = synthesize({
    awsAccess: 'assume-role',
    roleName: 'bot-cube-user-memory',
    chatServiceTaskRole: 'bot-cube-chat-service',
  });
  const roleId = () => {
    const [id] = Object.keys(
      assumed.findResources('AWS::IAM::Role', { Properties: { RoleName: 'bot-cube-user-memory' } })
    );
    assert(id, 'the stack declares the Memory role');
    return id;
  };

  test("the Memory role trusts only the Chat Service's task role, by ARN, with no OIDC provider or session tags", () => {
    assumed.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    assumed.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bot-cube-user-memory',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::123456789012:root']] } },
            Action: 'sts:AssumeRole',
            Condition: {
              ArnEquals: {
                'aws:PrincipalArn': {
                  'Fn::Join': [
                    '',
                    ['arn:', { Ref: 'AWS::Partition' }, ':iam::123456789012:role/bot-cube-chat-service'],
                  ],
                },
              },
            },
          },
        ],
      },
    });
  });

  test("the Memory role grants the Memory's event and record actions, which each Turn's session policy narrows", () => {
    const [memory] = Object.keys(assumed.findResources('AWS::BedrockAgentCore::Memory'));
    const policies = Object.values(assumed.findResources('AWS::IAM::Policy')).filter(policy =>
      policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId())
    );

    expect(policies.flatMap(policy => policy.Properties.PolicyDocument.Statement)).toEqual([
      {
        Effect: 'Allow',
        Action: [
          'CreateEvent',
          'GetEvent',
          'ListEvents',
          'DeleteEvent',
          'ListMemoryRecords',
          'RetrieveMemoryRecords',
          'GetMemoryRecord',
          'DeleteMemoryRecord',
        ].map(action => `bedrock-agentcore:${action}`),
        Resource: { 'Fn::GetAtt': [memory, 'MemoryArn'] },
      },
    ]);
  });

  test('outputs the Memory role ARN, and gives the Harness no role to assume', () => {
    assumed.hasOutput('UserMemoryRoleArn', { Value: { 'Fn::GetAtt': [roleId(), 'Arn'] } });
    for (const runtime of Object.values(assumed.findResources('AWS::BedrockAgentCore::Runtime'))) {
      expect(runtime.Properties.EnvironmentVariables).not.toHaveProperty('BOTCUBE_USER_MEMORY_ROLE_ARN');
    }
  });
});

test.each([
  { issuer: 'https://chat.example.com', roleName: 'bot-cube-user-memory' },
  { awsAccess: 'assume-role', chatServiceTaskRole: 'chat-task', roleName: 'bot-cube-user-memory' } as const,
])('grants the encrypted Memory key to the Turn role with %j', role => {
  const keyArn = 'arn:aws:kms:us-east-1:123456789012:key/enterprise-memory';
  const encrypted = synthesize(role, keyArn);
  const roleId = encrypted.getResourceId('AWS::IAM::Role', { Properties: { RoleName: role.roleName } });
  encrypted.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: roleId }],
    PolicyDocument: {
      Statement: Match.arrayWith([
        {
          Effect: 'Allow',
          Resource: keyArn,
          Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
        },
        { Effect: 'Allow', Resource: keyArn, Action: 'kms:DescribeKey' },
      ]),
    },
  });
});
