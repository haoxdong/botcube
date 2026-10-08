import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ok as assert } from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  AgentCoreStack,
  applyRuntimeLifecycleCap,
  RUNTIME_MAX_LIFETIME_SECONDS,
  RUNTIME_IDLE_TIMEOUT_SECONDS,
} from '../lib/cdk-stack';
import { readCdkContext } from '../lib/cdk-context';

const DEPLOY_ROOT = resolve(__dirname, '../../../../template/deploy');
const AGENTCORE_SPEC = resolve(DEPLOY_ROOT, 'agentcore/agentcore.json');
const DEPLOY_IDENTITY = JSON.parse(readFileSync(resolve(DEPLOY_ROOT, 'identity.json'), 'utf-8'));
const PHYSICAL_IDENTITY = {
  runtime: DEPLOY_IDENTITY.aws.agentCore.runtime,
  memory: DEPLOY_IDENTITY.aws.agentCore.memory,
  sessionApiFunction: DEPLOY_IDENTITY.aws.agentCore.sessionApiFunction,
  sessionApiAlias: DEPLOY_IDENTITY.aws.agentCore.sessionApiAlias,
  ecrRepository: DEPLOY_IDENTITY.aws.ecr.repository,
  codeBuildProject: DEPLOY_IDENTITY.aws.codeBuild.project,
  lambdaFunction: DEPLOY_IDENTITY.aws.lambda.family,
  roles: {
    memory: DEPLOY_IDENTITY.aws.iam.memoryRole,
    lambda: DEPLOY_IDENTITY.aws.iam.lambdaRole,
    runtime: DEPLOY_IDENTITY.aws.iam.runtimeRole,
    codeBuild: DEPLOY_IDENTITY.aws.iam.codeBuildRole,
    sessionApi: DEPLOY_IDENTITY.aws.iam.sessionApiRole,
  },
};
const PRIVATE_NAT_BROWSER = {
  name: 'test_private_browser',
  id: 'test_private_browser-AbCdEfGhIj',
  vpcId: 'vpc-fixture0123456789abcdef0',
  browserSecurityGroupId: 'sg-fixture0123456789abcdef1',
  extension: {
    bucket: 'browser-assets',
    prefix: 'extensions/provider-v1.zip',
    versionId: 'version-1',
  },
  subnets: [
    { id: 'subnet-fixture0123456789abcdef0', availabilityZone: 'us-east-1a', cidrBlock: '10.0.96.0/24' },
    { id: 'subnet-fixture0123456789abcdef1', availabilityZone: 'us-east-1b', cidrBlock: '10.0.97.0/24' },
  ],
};
setSessionProjectRoot(DEPLOY_ROOT);

test('AgentCoreStack synthesizes with empty spec', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
    physicalIdentity: PHYSICAL_IDENTITY,
  });
  const template = Template.fromStack(stack);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});

test('applyRuntimeLifecycleCap sets a ~1h maxLifetime + idle timeout on the runtime (ADR 0029)', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'RuntimeStack');
  const cfnRuntime = new bedrockagentcore.CfnRuntime(stack, 'Resource', {
    agentRuntimeName: 'test_runtime',
    agentRuntimeArtifact: {
      containerConfiguration: {
        containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test:latest',
      },
    },
    networkConfiguration: { networkMode: 'PUBLIC' },
    roleArn: 'arn:aws:iam::123456789012:role/test',
  });

  applyRuntimeLifecycleCap(cfnRuntime);

  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    LifecycleConfiguration: {
      MaxLifetime: RUNTIME_MAX_LIFETIME_SECONDS,
      IdleRuntimeSessionTimeout: RUNTIME_IDLE_TIMEOUT_SECONDS,
    },
  });
});

test('runtime maxLifetime cap is ~1h and within the AgentCore API bound (60..28800s)', () => {
  expect(RUNTIME_MAX_LIFETIME_SECONDS).toBe(3600);
  expect(RUNTIME_MAX_LIFETIME_SECONDS).toBeGreaterThanOrEqual(60);
  expect(RUNTIME_MAX_LIFETIME_SECONDS).toBeLessThanOrEqual(28800);
  expect(RUNTIME_IDLE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(60);
  expect(RUNTIME_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(28800);
});

test('private browser adopts pre-provisioned network identity without recreating it', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'PrivateNatBrowserStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
    physicalIdentity: PHYSICAL_IDENTITY,
    privateNatBrowser: PRIVATE_NAT_BROWSER,
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Subnet', 0);
  // The ECS app owns the NAT Gateway, Elastic IP and default route.
  template.resourceCountIs('AWS::EC2::EIP', 0);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::Route', 0);
  template.resourceCountIs('Custom::AWS', 0);
  template.resourceCountIs('AWS::BedrockAgentCore::BrowserCustom', 0);
  template.hasOutput('PrivateNatBrowserId', {
    Description: 'AgentCore browser ID using private NAT egress',
    Value: PRIVATE_NAT_BROWSER.id,
  });
  expect(JSON.stringify(template.toJSON())).not.toContain('modifyInstanceAttribute');
  expect(JSON.stringify(template.toJSON())).not.toContain('SourceDestCheck');
  expect(JSON.stringify(template.toJSON())).not.toContain('ec2:ModifyInstanceAttribute');
});

test('botcube_harness_deepagents memory enables all built-in extraction strategies under /strategies/', () => {
  const spec = JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8'));
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'MemoryStrategyStack', {
    spec,
    physicalIdentity: PHYSICAL_IDENTITY,
  });

  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Memory', {
    MemoryStrategies: [
      {
        UserPreferenceMemoryStrategy: {
          Name: 'UserPreferences',
          NamespaceTemplates: ['/strategies/{memoryStrategyId}/actors/{actorId}/'],
        },
      },
      {
        SemanticMemoryStrategy: {
          Name: 'SemanticFacts',
          NamespaceTemplates: ['/strategies/{memoryStrategyId}/actors/{actorId}/'],
        },
      },
      {
        SummaryMemoryStrategy: {
          Name: 'SessionSummary',
          NamespaceTemplates: ['/strategies/{memoryStrategyId}/actors/{actorId}/sessions/{sessionId}/summary/'],
        },
      },
      {
        EpisodicMemoryStrategy: {
          Name: 'EpisodicLearning',
          NamespaceTemplates: ['/strategies/{memoryStrategyId}/actors/{actorId}/episodes/{sessionId}/'],
          ReflectionConfiguration: {
            NamespaceTemplates: ['/strategies/{memoryStrategyId}/actors/{actorId}/episodes/'],
          },
        },
      },
    ],
  });
});

test('runtime IAM denies every Memory operation and retains only audited harmless permissions', () => {
  const stack = new AgentCoreStack(new cdk.App(), 'MemoryIsolationStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
  });
  const template = Template.fromStack(stack);
  const roleId = Object.keys(template.findResources('AWS::IAM::Role')).find(id => id.includes('RuntimeExecutionRole'));
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter(policy =>
    policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId)
  );
  const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const actions = [...new Set<string>(statements.flatMap(statement => [statement.Action].flat()))].sort();
  expect(actions).toEqual(
    [
      'bedrock:CountTokens',
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:GetAuthorizationToken',
      'ecr:GetDownloadUrlForLayer',
      'kms:Decrypt',
      'logs:CreateLogGroup',
      'logs:CreateLogStream',
      'logs:DescribeLogGroups',
      'logs:DescribeLogStreams',
      'logs:PutLogEvents',
      'xray:PutTelemetryRecords',
      'xray:PutTraceSegments',
    ].sort()
  );
  const match = (pattern: string, value: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value);
  const allows = (action: string, resource: string) =>
    statements.some(
      statement =>
        statement.Effect === 'Allow' &&
        [statement.Action].flat().some((pattern: string) => match(pattern, action)) &&
        [statement.Resource].flat().some((pattern: unknown) => typeof pattern === 'string' && match(pattern, resource))
    );
  expect(allows('xray:PutTraceSegments', '*')).toBe(true);
  const memoryActions = [
    'GetMemory',
    'ListMemories',
    'CreateMemory',
    'UpdateMemory',
    'DeleteMemory',
    'ListActors',
    'ListSessions',
    'GetEvent',
    'ListEvents',
    'CreateEvent',
    'DeleteEvent',
    'ListMemoryRecords',
    'RetrieveMemoryRecords',
    'GetMemoryRecord',
    'DeleteMemoryRecord',
    'BatchCreateMemoryRecords',
    'BatchUpdateMemoryRecords',
    'BatchDeleteMemoryRecords',
  ];
  for (const action of memoryActions) {
    for (const namespace of ['/strategies/', '/strategies/test/actors/own/', '/strategies/test/actors/other/']) {
      expect(
        allows(
          `bedrock-agentcore:${action}`,
          `arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test${namespace}`
        )
      ).toBe(false);
    }
  }
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: PHYSICAL_IDENTITY.roles.runtime,
    ManagedPolicyArns: Match.absent(),
  });
});

test('synthesizes the Cartridge-owned physical resource identities', () => {
  const spec = JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8'));
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'PhysicalIdentityStack', {
    spec,
    physicalIdentity: PHYSICAL_IDENTITY,
    harnessCodeLocation: resolve(DEPLOY_ROOT, spec.runtimes[0].codeLocation),
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: PHYSICAL_IDENTITY.runtime,
  });
  template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
    Name: PHYSICAL_IDENTITY.memory,
  });
  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: PHYSICAL_IDENTITY.ecrRepository,
  });
  template.hasResourceProperties('AWS::CodeBuild::Project', {
    Name: PHYSICAL_IDENTITY.codeBuildProject,
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: PHYSICAL_IDENTITY.lambdaFunction,
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: PHYSICAL_IDENTITY.sessionApiFunction,
  });
  for (const roleName of Object.values(PHYSICAL_IDENTITY.roles)) {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: roleName });
  }
});

test('synthesizes the deployed build-handler and IAM policy shape', () => {
  const spec = JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8'));
  const app = new cdk.App({
    context: readCdkContext(resolve(__dirname, '../cdk.json')),
  });
  const stack = new AgentCoreStack(app, 'DeploymentShapeStack', {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    spec,
    physicalIdentity: PHYSICAL_IDENTITY,
  });
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, Record<string, unknown>>;
  const resourceValues = Object.values(resources);
  const logGroupEntry = Object.entries(resources).find(([, resource]) => resource.Type === 'AWS::Logs::LogGroup');

  expect(logGroupEntry).toBeDefined();
  expect(resourceValues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: 'AWS::Logs::LogGroup',
        Properties: expect.objectContaining({
          LogGroupName: expect.objectContaining({
            'Fn::Join': ['', expect.arrayContaining(['/aws/lambda/'])],
          }),
          RetentionInDays: 731,
        }),
        UpdateReplacePolicy: 'Retain',
        DeletionPolicy: 'Retain',
      }),
    ])
  );

  assert(logGroupEntry);
  const [logGroupLogicalId] = logGroupEntry;
  expect(resourceValues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: 'AWS::BedrockAgentCore::Runtime',
        DependsOn: expect.arrayContaining([logGroupLogicalId]),
      }),
      expect.objectContaining({
        Type: 'AWS::IAM::Policy',
        DependsOn: expect.arrayContaining([logGroupLogicalId]),
      }),
    ])
  );

  const policyStatements = resourceValues
    .filter(resource => resource.Type === 'AWS::IAM::Policy')
    .flatMap(resource => {
      const properties = resource.Properties as {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
      };
      return properties.PolicyDocument?.Statement ?? [];
    });

  expect(policyStatements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Action: [
          'ecr:GetAuthorizationToken',
          'logs:DescribeLogGroups',
          'xray:PutTelemetryRecords',
          'xray:PutTraceSegments',
        ],
        Effect: 'Allow',
        Resource: '*',
      }),
      expect.objectContaining({
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        Effect: 'Allow',
        Resource: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/codebuild/*',
      }),
      expect.objectContaining({
        Action: ['s3:GetBucket*', 's3:GetObject*', 's3:List*'],
        Effect: 'Allow',
        Resource: [
          'arn:aws:s3:::cdk-hnb659fds-assets-123456789012-us-east-1',
          'arn:aws:s3:::cdk-hnb659fds-assets-123456789012-us-east-1/*',
        ],
      }),
    ])
  );
});

test('grants the runtime role tracing and no browser access (ADR 0075 decision 5)', () => {
  const stack = new AgentCoreStack(new cdk.App(), 'RuntimeGrantsStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
  });

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [
      { Ref: Object.keys(template.findResources('AWS::IAM::Role')).find(id => id.includes('RuntimeExecutionRole')) },
    ],
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectEquals({
          Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          Effect: 'Allow',
          Resource: '*',
        }),
      ]),
    },
  });
  expect(JSON.stringify(template.findResources('AWS::BedrockAgentCore::Runtime'))).not.toMatch(/LANGSMITH|LANGCHAIN/);
  expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('ssm:GetParameter');
  // The agent reaches its Agent Computer only through the Chat Service's CDP filter.
  expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toMatch(/Browser/);
});

test('caps the lifecycle of the runtime the stack deploys (ADR 0029)', () => {
  const stack = new AgentCoreStack(new cdk.App(), 'RuntimeLifecycleStack', {
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
  });

  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    LifecycleConfiguration: {
      MaxLifetime: RUNTIME_MAX_LIFETIME_SECONDS,
      IdleRuntimeSessionTimeout: RUNTIME_IDLE_TIMEOUT_SECONDS,
    },
  });
});

test("the agent's shell works in the runtime's session storage (ADR 0077)", () => {
  const stack = new AgentCoreStack(new cdk.App(), 'SessionStorageStack', {
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
  });

  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    FilesystemConfigurations: [{ SessionStorage: { MountPath: '/mnt/workspace' } }],
    EnvironmentVariables: Match.objectLike({ BOTCUBE_WORKSPACE: '/mnt/workspace' }),
  });
});

test("the runtime role reaches no account's Files: no S3 or S3 Files action (ADR 0077)", () => {
  const stack = new AgentCoreStack(new cdk.App(), 'RuntimeFilesStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
    privateNatBrowser: PRIVATE_NAT_BROWSER,
  });
  const template = Template.fromStack(stack).toJSON() as {
    Resources: Record<
      string,
      {
        Type: string;
        Properties: {
          Roles?: unknown[];
          PolicyDocument?: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
        };
      }
    >;
  };
  const runtimeRole = Object.entries(template.Resources).find(
    ([, resource]) =>
      resource.Type === 'AWS::IAM::Role' && JSON.stringify(resource).includes(PHYSICAL_IDENTITY.roles.runtime)
  )?.[0];
  assert(runtimeRole);
  const statements = Object.values(template.Resources)
    .filter(
      ({ Type, Properties }) =>
        Type === 'AWS::IAM::Policy' &&
        JSON.stringify(Properties.Roles).match(new RegExp(`"(${runtimeRole}|${PHYSICAL_IDENTITY.roles.runtime})"`))
    )
    .flatMap(({ Properties }) => Properties.PolicyDocument?.Statement ?? []);
  const actions = (statement: { Action: string | string[] }) => [statement.Action].flat();

  expect(statements.length).toBeGreaterThan(0);
  expect(statements.flatMap(actions).filter(action => /^s3files:|^\*$/.test(action))).toEqual([]);
  expect(statements.flatMap(actions).filter(action => action.startsWith('s3:'))).toEqual([]);
});

test('refuses a spec whose resources cannot take the one Cartridge-owned name', () => {
  const spec = JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8'));
  spec.runtimes.push({ ...spec.runtimes[0], name: 'second_runtime' });

  expect(
    () =>
      new AgentCoreStack(new cdk.App(), 'TwoRuntimesStack', {
        spec,
        physicalIdentity: PHYSICAL_IDENTITY,
      })
  ).toThrow(new Error('Expected one AWS::BedrockAgentCore::Runtime resource, found 2'));
});

test('existing resources replace runtime role and network without creating or mutating external infrastructure', () => {
  const app = new cdk.App();
  const imports = new cdk.Stack(app, 'Imports', { env: { account: '123456789012', region: 'us-east-1' } });
  const roleArn = 'arn:aws:iam::123456789012:role/corporate-runtime';
  const boundaryArn = 'arn:aws:iam::123456789012:policy/corporate-boundary';
  const keyArn = 'arn:aws:kms:us-east-1:123456789012:key/corporate-key';
  const spec = JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8'));
  const original = JSON.stringify(spec);
  const vpc = ec2.Vpc.fromVpcAttributes(imports, 'Vpc', {
    vpcId: 'vpc-corporate',
    availabilityZones: ['us-east-1a'],
    privateSubnetIds: ['subnet-corporate'],
  });
  const stack = new AgentCoreStack(app, 'Corporate', {
    env: { account: '123456789012', region: 'us-east-1' },
    spec,
    physicalIdentity: PHYSICAL_IDENTITY,
    executionRole: iam.Role.fromRoleArn(imports, 'Role', roleArn, { mutable: false }),
    vpc,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [ec2.SecurityGroup.fromSecurityGroupId(imports, 'Group', 'sg-corporate')],
    runtimeSecurityGroupName: 'unused-fallback-name',
    kmsKey: kms.Key.fromKeyArn(imports, 'Key', keyArn),
    permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(imports, 'Boundary', boundaryArn),
    workspace: '/mnt/corporate',
    runtimeMaxLifetimeSeconds: 1800,
    runtimeIdleTimeoutSeconds: 600,
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    RoleArn: roleArn,
    NetworkConfiguration: {
      NetworkMode: 'VPC',
      NetworkModeConfig: { Subnets: ['subnet-corporate'], SecurityGroups: ['sg-corporate'] },
    },
    LifecycleConfiguration: { MaxLifetime: 1800, IdleRuntimeSessionTimeout: 600 },
    FilesystemConfigurations: [{ SessionStorage: { MountPath: '/mnt/corporate' } }],
  });
  template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
  template.hasResourceProperties('AWS::BedrockAgentCore::Memory', { EncryptionKeyArn: keyArn });
  expect({
    runtime: Object.values(template.findResources('AWS::BedrockAgentCore::Runtime')).map(resource => ({
      role: resource.Properties.RoleArn,
      network: resource.Properties.NetworkConfiguration,
      lifecycle: resource.Properties.LifecycleConfiguration,
      filesystem: resource.Properties.FilesystemConfigurations,
    })),
    memory: Object.values(template.findResources('AWS::BedrockAgentCore::Memory')).map(
      resource => resource.Properties.EncryptionKeyArn
    ),
  }).toMatchSnapshot();
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  expect(roles.map(role => role.Properties.RoleName)).not.toContain(PHYSICAL_IDENTITY.roles.runtime);
  for (const role of roles) expect(role.Properties.PermissionsBoundary).toBe(boundaryArn);
  expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('corporate-runtime');
  expect(JSON.stringify(spec)).toBe(original);
});

test('omitted resource props retain the default runtime configuration snapshot', () => {
  const stack = new AgentCoreStack(new cdk.App(), 'DefaultResources', {
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
  });
  const template = Template.fromStack(stack);
  expect(
    Object.values(template.findResources('AWS::BedrockAgentCore::Runtime')).map(resource => ({
      network: resource.Properties.NetworkConfiguration,
      lifecycle: resource.Properties.LifecycleConfiguration,
      filesystem: resource.Properties.FilesystemConfigurations,
    }))
  ).toMatchSnapshot();
});

test('example Memory keeps its resource identity and supplies only valid runtime environment names', () => {
  const spec = JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8'));
  spec.runtimes[0].name = 'example-agent';
  spec.memories[0].name = 'example-agent';
  const stack = new AgentCoreStack(new cdk.App(), 'ExampleResourceIdentity', {
    spec,
    physicalIdentity: PHYSICAL_IDENTITY,
  });
  const template = Template.fromStack(stack);
  const memories = template.findResources('AWS::BedrockAgentCore::Memory');
  expect(Object.keys(memories)).toEqual(['ApplicationMemoryExampleAgent9C2DBE46']);
  const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
  expect(Object.keys(runtimes)).toEqual(['ApplicationAgentExampleAgentRuntimeE00F84C8']);
  template.hasResourceProperties('AWS::BedrockAgentCore::Memory', { Name: PHYSICAL_IDENTITY.memory });
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { AgentRuntimeName: PHYSICAL_IDENTITY.runtime });
  const runtime = Object.values(runtimes)[0];
  assert(runtime);
  const variables = runtime.Properties.EnvironmentVariables;
  expect(variables.AGENTCORE_MEMORY_ID).toBeDefined();
  expect(variables).not.toHaveProperty('MEMORY_EXAMPLE-AGENT_ID');
  expect(Object.keys(variables).every(name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name))).toBe(true);
});

test.each([
  ['runtimeMaxLifetimeSeconds', 3601, 3600],
  ['runtimeIdleTimeoutSeconds', 901, 900],
  ...['runtimeMaxLifetimeSeconds', 'runtimeIdleTimeoutSeconds'].flatMap(name =>
    [0, -1, 59, 60.5, NaN, Infinity].map(value => [name, value, name === 'runtimeMaxLifetimeSeconds' ? 3600 : 900])
  ),
])('rejects runtime lifecycle %s=%s outside its API bounds and permanent cap', (name, value, cap) => {
  expect(
    () =>
      new AgentCoreStack(new cdk.App(), 'InvalidLifecycle', {
        spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
        physicalIdentity: PHYSICAL_IDENTITY,
        [name]: value,
      })
  ).toThrow(`${name} must be an integer between 60 and ${cap} seconds (ADR 0029)`);
});

test.each([
  [3600, 900],
  [1800, 600],
  [60, 60],
])('accepts runtime lifecycle at the caps and below (%s, %s)', (maxLifetime, idleTimeout) => {
  const stack = new AgentCoreStack(new cdk.App(), 'ConfiguredLifecycle', {
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
    runtimeMaxLifetimeSeconds: maxLifetime,
    runtimeIdleTimeoutSeconds: idleTimeout,
  });
  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    LifecycleConfiguration: { MaxLifetime: maxLifetime, IdleRuntimeSessionTimeout: idleTimeout },
  });
});

test('adopters name the security group created for a runtime VPC', () => {
  const app = new cdk.App();
  const imports = new cdk.Stack(app, 'Imports', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(imports, 'Vpc', {
    vpcId: 'vpc-adopter',
    availabilityZones: ['us-east-1a'],
    privateSubnetIds: ['subnet-adopter'],
  });
  const stack = new AgentCoreStack(app, 'NamedRuntime', {
    env: { account: '123456789012', region: 'us-east-1' },
    spec: JSON.parse(readFileSync(AGENTCORE_SPEC, 'utf-8')),
    physicalIdentity: PHYSICAL_IDENTITY,
    vpc,
    runtimeSecurityGroupName: 'adopter-runtime',
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'adopter-runtime' });
  const [groupId] = Object.keys(template.findResources('AWS::EC2::SecurityGroup'));
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    NetworkConfiguration: {
      NetworkMode: 'VPC',
      NetworkModeConfig: { SecurityGroups: [{ 'Fn::GetAtt': [groupId, 'GroupId'] }] },
    },
  });
});
