import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { addAgentCoreStacks } from '../lib/agentcore-app';
import type { AgentCoreStack } from '../lib/cdk-stack';
import type { DeployConfig } from '../lib/deploy-config';

const COMMIT = 'abc123';
const DEPLOY_ROOT = resolve(__dirname, '../../../../template/deploy');
setSessionProjectRoot(DEPLOY_ROOT);

const PRIVATE_NAT_BROWSER = {
  name: 'template_private_browser',
  id: 'template_private_browser-AbCdEfGhIj',
  vpcId: 'vpc-fixture0123456789abcdef0',
  browserSecurityGroupId: 'sg-fixture0123456789abcdef1',
  extension: { bucket: 'browser-assets', prefix: 'extensions/template.zip', versionId: 'version-1' },
  subnets: [
    { id: 'subnet-fixture0123456789abcdef0', availabilityZone: 'us-east-1a', cidrBlock: '10.0.96.0/24' },
    { id: 'subnet-fixture0123456789abcdef1', availabilityZone: 'us-east-1b', cidrBlock: '10.0.97.0/24' },
  ],
};

function deployConfig(agentCore: Record<string, unknown> = {}): DeployConfig {
  const identity = JSON.parse(readFileSync(resolve(DEPLOY_ROOT, 'identity.json'), 'utf8'));
  const spec = JSON.parse(readFileSync(resolve(DEPLOY_ROOT, 'agentcore/agentcore.json'), 'utf8'));
  identity.aws.cloudFormation.stackFamily = 'template_agent';
  Object.assign(identity.aws.agentCore, agentCore);
  return {
    deployRoot: DEPLOY_ROOT,
    identity,
    spec,
    targets: [{ name: 'prod_east', account: '000000000000', region: 'us-east-1' }],
  };
}

function onlyStack(app: App): AgentCoreStack {
  const stacks = app.node.children;
  expect(stacks).toHaveLength(1);
  return stacks[0] as AgentCoreStack;
}

test('fails loud when the spec declares no runtime', () => {
  const config = deployConfig();
  config.spec.runtimes = [];

  expect(() => addAgentCoreStacks(new App(), config, COMMIT)).toThrow(
    'The AgentCore spec declares no runtime to deploy'
  );
});

test('adds one stack per target, named for the stack family and target, in its account and region', () => {
  const app = new App();
  const config = deployConfig();
  config.targets = [
    { name: 'prod_east', account: '000000000000', region: 'us-east-1' },
    { name: 'prod_west', account: '000000000000', region: 'us-west-2' },
  ];

  addAgentCoreStacks(app, config, COMMIT);

  const stacks = app.node.children as AgentCoreStack[];
  expect(stacks.map(stack => [stack.stackName, stack.account, stack.region])).toEqual([
    ['AgentCore-template-agent-prod-east', '000000000000', 'us-east-1'],
    ['AgentCore-template-agent-prod-west', '000000000000', 'us-west-2'],
  ]);
});

test('describes and tags the stack with the project and target', () => {
  const app = new App();

  addAgentCoreStacks(app, deployConfig(), COMMIT);

  const stack = onlyStack(app);
  expect(Template.fromStack(stack).toJSON().Description).toBe(
    'AgentCore stack for botcube deployed to prod_east (us-east-1)'
  );
  expect(stack.tags.tagValues()).toEqual({
    'agentcore:project-name': 'botcube',
    'agentcore:target-name': 'prod_east',
  });
});

test('outputs the deployed commit for scripts/dev-status.sh', () => {
  const app = new App();

  addAgentCoreStacks(app, deployConfig(), COMMIT);

  Template.fromStack(onlyStack(app)).hasOutput('Commit', { Value: COMMIT });
});

test('names every resource from identity.json and builds the session API from the runtime source', () => {
  const app = new App();
  const { identity } = deployConfig();

  addAgentCoreStacks(app, deployConfig(), COMMIT);

  const template = Template.fromStack(onlyStack(app));
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: identity.aws.agentCore.runtime,
  });
  template.hasResourceProperties('AWS::BedrockAgentCore::Memory', { Name: identity.aws.agentCore.memory });
  template.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: identity.aws.ecr.repository });
  template.hasResourceProperties('AWS::CodeBuild::Project', { Name: identity.aws.codeBuild.project });
  template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: identity.aws.lambda.family });
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: identity.aws.agentCore.sessionApiFunction,
  });
  for (const roleName of [
    identity.aws.iam.runtimeRole,
    identity.aws.iam.memoryRole,
    identity.aws.iam.lambdaRole,
    identity.aws.iam.codeBuildRole,
    identity.aws.iam.sessionApiRole,
  ]) {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: roleName });
  }
});

test('keeps the runtime on the public network without a runtime network parameter', () => {
  const app = new App();

  addAgentCoreStacks(app, deployConfig({ runtimeNetworkParameter: undefined }), COMMIT);

  Template.fromStack(onlyStack(app)).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    NetworkConfiguration: { NetworkMode: 'PUBLIC' },
  });
});

test('puts the runtime in the private NAT browser subnets behind the parameterized security group', () => {
  const app = new App();

  addAgentCoreStacks(
    app,
    deployConfig({
      runtimeNetworkParameter: '/template/agentcore/security-group-id',
      privateNatBrowser: PRIVATE_NAT_BROWSER,
    }),
    COMMIT
  );

  const template = Template.fromStack(onlyStack(app));
  const [securityGroupParameter] = Object.keys(
    template.findParameters('*', { Default: '/template/agentcore/security-group-id' })
  );
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    NetworkConfiguration: {
      NetworkMode: 'VPC',
      NetworkModeConfig: {
        Subnets: ['subnet-fixture0123456789abcdef0', 'subnet-fixture0123456789abcdef1'],
        SecurityGroups: [{ Ref: securityGroupParameter }],
      },
    },
  });
  template.hasOutput('PrivateNatBrowserId', { Value: PRIVATE_NAT_BROWSER.id });
});

test.each([undefined, false, 'false', true, 'true'])('validates the explicit Memory migration context %s', context => {
  const app = new App({ context: context === undefined ? {} : { retainLegacyRuntimeMemory: context } });
  addAgentCoreStacks(app, deployConfig(), COMMIT);
  const template = Template.fromStack(onlyStack(app));
  const retained = context === true || context === 'true';
  template.hasOutput('LegacyRuntimeMemoryRetained', { Value: String(retained) });
  const roleId = Object.keys(template.findResources('AWS::IAM::Role')).find(id => id.includes('RuntimeExecutionRole'));
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter(policy =>
    policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId)
  );
  const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const actions = [...new Set<string>(statements.flatMap(statement => [statement.Action].flat()))];
  expect(
    actions.filter(action => ['logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:PutResourcePolicy'].includes(action))
  ).toEqual([]);
  expect(actions.some(action => action.includes('ConfigurationBundle'))).toBe(false);
  const memoryActions = actions.filter(action => action.startsWith('bedrock-agentcore:'));
  if (!retained) expect(memoryActions).toEqual([]);
  else {
    expect(memoryActions.sort()).toEqual(
      [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:DeleteEvent',
        'bedrock-agentcore:DeleteMemoryRecord',
        'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:GetMemory',
        'bedrock-agentcore:GetMemoryRecord',
        'bedrock-agentcore:ListActors',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:ListMemoryRecords',
        'bedrock-agentcore:ListSessions',
        'bedrock-agentcore:RetrieveMemoryRecords',
      ].sort()
    );
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Action: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
          Condition: { StringEquals: { 'bedrock-agentcore:namespacePath': '/strategies/' } },
          Resource: expect.objectContaining({ 'Fn::GetAtt': expect.arrayContaining(['MemoryArn']) }),
        }),
      ])
    );
  }
});

test.each(['yes', '', 1, null])('rejects malformed Memory migration context %s', context => {
  const app = new App({ context: { retainLegacyRuntimeMemory: context } });
  expect(() => addAgentCoreStacks(app, deployConfig(), COMMIT)).toThrow(
    'retainLegacyRuntimeMemory must be true or false'
  );
});
