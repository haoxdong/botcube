import { ok as assert } from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { AgentCoreStack, SESSION_API_TIMEOUT_SECONDS } from '../lib/cdk-stack';

const DEPLOY_ROOT = resolve(__dirname, '../../../../template/deploy');
const SPEC = JSON.parse(readFileSync(resolve(DEPLOY_ROOT, 'agentcore/agentcore.json'), 'utf-8'));
const IDENTITY = JSON.parse(readFileSync(resolve(DEPLOY_ROOT, 'identity.json'), 'utf-8'));
const HARNESS = resolve(DEPLOY_ROOT, SPEC.runtimes[0].codeLocation);
setSessionProjectRoot(DEPLOY_ROOT);

function stack(app = new cdk.App()): AgentCoreStack {
  return new AgentCoreStack(app, 'SessionApiStack', {
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
    harnessCodeLocation: HARNESS,
  });
}

function template(): Template {
  return Template.fromStack(stack());
}

function memoryId(synthesized: Template): string {
  const [id] = Object.keys(synthesized.findResources('AWS::BedrockAgentCore::Memory'));
  assert(id, 'the stack declares an AgentCore memory');
  return id;
}

test('the session API is its own function beside the runtime, reading the Session record', () => {
  const synthesized = template();

  synthesized.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: IDENTITY.aws.agentCore.sessionApiFunction,
    PackageType: 'Image',
    Architectures: ['arm64'],
    Timeout: SESSION_API_TIMEOUT_SECONDS,
    Environment: {
      Variables: Match.objectLike({
        AGENTCORE_MEMORY_ID: { 'Fn::GetAtt': [memoryId(synthesized), 'MemoryId'] },
        AGENTCORE_REGION: 'us-east-1',
      }),
    },
  });
  synthesized.hasResourceProperties('AWS::IAM::Role', { RoleName: IDENTITY.aws.iam.sessionApiRole });
});

test('the Chat Service calls an alias kept initialized, so a page load waits on no cold start', () => {
  const synthesized = template();
  const [functionId] = Object.keys(
    synthesized.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: IDENTITY.aws.agentCore.sessionApiFunction },
    })
  );
  assert(functionId, 'the stack declares the session API function');

  synthesized.hasResourceProperties('AWS::Lambda::Alias', {
    Name: IDENTITY.aws.agentCore.sessionApiAlias,
    FunctionName: { Ref: functionId },
    ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 5 },
  });
});

test('a purge fits in one invocation at the per-Session delete rate', () => {
  // 5 deletes a second; the Chat Service waits up to 900 s for a purge.
  expect(SESSION_API_TIMEOUT_SECONDS).toBe(900);
});

test("the session API may only list, create and delete events, list, update and delete the memory's records, and read its LangSmith key", () => {
  const synthesized = template();
  const roles = synthesized.findResources('AWS::IAM::Role', {
    Properties: { RoleName: IDENTITY.aws.iam.sessionApiRole },
  });
  const [roleId] = Object.keys(roles);
  const policies = Object.values(
    synthesized.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: roleId }] },
    })
  );
  const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);

  expect(statements).toEqual([
    {
      Action: ['bedrock-agentcore:ListEvents', 'bedrock-agentcore:CreateEvent', 'bedrock-agentcore:DeleteEvent'],
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [memoryId(synthesized), 'MemoryArn'] },
    },
    {
      Action: 'bedrock-agentcore:ListMemoryRecords',
      Condition: { StringEquals: { 'bedrock-agentcore:namespacePath': '/strategies/' } },
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [memoryId(synthesized), 'MemoryArn'] },
    },
    {
      Action: ['bedrock-agentcore:BatchUpdateMemoryRecords', 'bedrock-agentcore:DeleteMemoryRecord'],
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [memoryId(synthesized), 'MemoryArn'] },
    },
  ]);
});

test('the session API has no public endpoint and grants no one invocation', () => {
  const synthesized = template();

  synthesized.resourceCountIs('AWS::Lambda::Url', 0);
  synthesized.resourceCountIs('AWS::Lambda::Permission', 0);
});

test('the runtime writes Sessions to the memory the session API reads', () => {
  const synthesized = template();

  synthesized.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({
      AGENTCORE_MEMORY_ID: { 'Fn::GetAtt': [memoryId(synthesized), 'MemoryId'] },
    }),
  });
});

test('the session API runs as Lambda with basic execution logging, one month of logs under its own name', () => {
  const synthesized = template();

  synthesized.hasResourceProperties('AWS::IAM::Role', {
    RoleName: IDENTITY.aws.iam.sessionApiRole,
    AssumeRolePolicyDocument: {
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    },
    ManagedPolicyArns: [
      {
        'Fn::Join': [
          '',
          ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        ],
      },
    ],
  });
  synthesized.hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: `/aws/lambda/${IDENTITY.aws.agentCore.sessionApiFunction}`,
    RetentionInDays: 30,
  });
});

test('the session API image builds from the Harness source with its own Dockerfile for arm64', () => {
  const app = new cdk.App();
  const sessionApiStack = stack(app);
  const assembly = app.synth();
  const manifest: { dockerImages: Record<string, { source: { dockerFile?: string; platform?: string } }> } = JSON.parse(
    readFileSync(join(assembly.directory, `${sessionApiStack.artifactId}.assets.json`), 'utf8')
  );
  const images = Object.values(manifest.dockerImages);

  expect(images.map(image => image.source)).toContainEqual(
    expect.objectContaining({ dockerFile: 'session-api.Dockerfile', platform: 'linux/arm64' })
  );
});
