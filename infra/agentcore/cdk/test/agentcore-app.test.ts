import { readConfig } from 'botcube-config/read';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { addAgentCoreStacks } from '../lib/agentcore-app';
import type { AgentCoreStack } from '../lib/cdk-stack';
import {
  agentCoreProjectRoot,
  loadDeployConfig,
  readDeployIdentity,
  readProjectSpec,
  type DeployConfig,
} from '../lib/deploy-config';

const COMMIT = 'abc123';
const DEPLOY_ROOT = resolve(__dirname, '../../../../examples/public/deploy');
setSessionProjectRoot(agentCoreProjectRoot(readProjectSpec(DEPLOY_ROOT)));

const PRIVATE_NAT_BROWSER = {
  name: 'template_private_browser',
  id: 'template_private_browser-AbCdEfGhIj',
  vpcId: 'vpc-fixture0123456789abcdef0',
  browserSecurityGroupId: 'sg-fixture0123456789abcdef1',
  extension: { bucket: 'browser-assets', prefix: 'extensions/template.zip', versionId: 'version-1' },
  subnets: [
    { id: 'subnet-fixture0123456789abcdef0', availabilityZone: 'us-east-1a', cidrBlock: '192.0.2.0/24' },
    { id: 'subnet-fixture0123456789abcdef1', availabilityZone: 'us-east-1b', cidrBlock: '198.51.100.0/24' },
  ],
};

function deployConfig(agentCore: Record<string, unknown> = {}): DeployConfig {
  const identity = readDeployIdentity(DEPLOY_ROOT);
  const spec = readProjectSpec(DEPLOY_ROOT);
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

test.each(['V1', 'V2'] as const)(
  'deploys configured %s independently from the removable V1 endpoint',
  platformVersion => {
    const app = new App();
    addAgentCoreStacks(app, deployConfig({ platformVersion, rollbackVersion: '421' }), COMMIT);
    const stack = onlyStack(app);
    const template = Template.fromStack(stack);
    const [runtimeId] = Object.keys(template.findResources('AWS::BedrockAgentCore::Runtime'));
    expect(runtimeId).toBeDefined();
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { PlatformVersion: platformVersion });
    template.hasResourceProperties('AWS::BedrockAgentCore::RuntimeEndpoint', {
      AgentRuntimeId: { 'Fn::GetAtt': [runtimeId, 'AgentRuntimeId'] },
      AgentRuntimeVersion: '421',
      Name: 'V1_ROLLBACK',
    });
    template.hasResource('AWS::BedrockAgentCore::RuntimeEndpoint', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    template.hasOutput('RuntimePlatformVersion', { Value: platformVersion });
    template.hasOutput('V1RollbackVersion', { Value: '421' });
  }
);

test('defaults every bot to V2 without a rollback endpoint', () => {
  const app = new App();
  addAgentCoreStacks(app, deployConfig(), COMMIT);
  const template = Template.fromStack(onlyStack(app));
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { PlatformVersion: 'V2' });
  template.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 0);
  template.hasOutput('RuntimePlatformVersion', { Value: 'V2' });
});

test('rejects a symbolic V1 rollback version at the public deployment seam', () => {
  expect(() => addAgentCoreStacks(new App(), deployConfig({ rollbackVersion: 'DEFAULT' }), COMMIT)).toThrow(
    'numeric runtime version'
  );
});

test.each(['unknown', null])('rejects invalid declared platform %s', platformVersion => {
  expect(() => addAgentCoreStacks(new App(), deployConfig({ platformVersion }), COMMIT)).toThrow(
    'Runtime platform must be V1 or V2'
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

interface Resource {
  Type: string;
  DependsOn?: string[];
  Properties: {
    Role?: { 'Fn::GetAtt': [string, string] };
    LoggingConfig?: { LogGroup?: { Ref: string } };
    ManagedPolicyArns?: unknown[];
    Roles?: { Ref: string }[];
    PolicyDocument?: { Statement: { Action: string | string[]; Resource: unknown }[] };
  };
}

test('holds no AWS managed policy on any Lambda role: each function writes its own log group by an inline grant it deploys after', () => {
  const app = new App();
  addAgentCoreStacks(app, deployConfig(), COMMIT);
  const resources: Record<string, Resource> = Template.fromStack(onlyStack(app)).toJSON().Resources;

  const functions = Object.entries(resources).filter(([, { Type }]) => Type === 'AWS::Lambda::Function');
  const strays = functions.flatMap(([logicalId, { Properties, DependsOn = [] }]) => {
    const own = Properties.LoggingConfig?.LogGroup?.Ref;
    const roleId = Properties.Role?.['Fn::GetAtt'][0];
    const logsPolicies = Object.entries(resources).filter(
      ([, { Type, Properties: policy }]) =>
        Type === 'AWS::IAM::Policy' &&
        policy.Roles?.some(role => role.Ref === roleId) &&
        (policy.PolicyDocument?.Statement ?? []).some(statement =>
          [statement.Action].flat().includes('logs:PutLogEvents')
        )
    );
    const written = logsPolicies
      .flatMap(([, { Properties: policy }]) => policy.PolicyDocument?.Statement ?? [])
      .filter(statement => [statement.Action].flat().includes('logs:PutLogEvents'))
      .map(statement => JSON.stringify(statement.Resource));
    const managed = roleId ? resources[roleId]?.Properties.ManagedPolicyArns : undefined;
    const ordered = logsPolicies.every(([policyId]) => DependsOn.includes(policyId));
    const ownOnly = own && written.length > 0 && written.every(resource => resource.includes(`"${own}"`));
    return !managed && ordered && ownOnly ? [] : [logicalId];
  });
  expect(functions.length).toBeGreaterThan(1);
  expect(strays).toEqual([]);
});

test('names every resource from identity.json and builds the session API from the runtime source', () => {
  const app = new App();
  const { identity } = deployConfig();

  addAgentCoreStacks(app, deployConfig(), COMMIT);

  const template = Template.fromStack(onlyStack(app));
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: identity.aws.agentCore.runtime,
    RequestHeaderConfiguration: { RequestHeaderAllowlist: ['X-BotCube-Credential-Invocation'] },
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
    identity.aws.iam.userMemoryRole,
    identity.aws.iam.lambdaRole,
    identity.aws.iam.codeBuildRole,
    identity.aws.iam.sessionApiRole,
  ]) {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: roleName });
  }
});

test("registers the Chat Service's https origin from identity.json as the Memory role's OIDC provider", () => {
  const app = new App();
  const { identity } = deployConfig();

  addAgentCoreStacks(app, deployConfig(), COMMIT);

  const template = Template.fromStack(onlyStack(app));
  template.hasResourceProperties('AWS::IAM::OIDCProvider', {
    Url: `https://${new URL(identity.domains.chatService).hostname}`,
  });
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: identity.aws.iam.userMemoryRole,
    MaxSessionDuration: 3600,
  });
});

test('under assume-role, refuses a deploy identity that names no Chat Service task role for the Memory role to trust', () => {
  const config = deployConfig();
  delete config.identity.aws.iam.chatServiceTaskRole;

  expect(() => addAgentCoreStacks(new App(), config, COMMIT, {}, 'assume-role')).toThrow(
    'Deploy identity aws.iam.chatServiceTaskRole: required with awsAccess assume-role'
  );
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

test('the deployed runtime role keeps no Memory, log-read or configuration-bundle permission', () => {
  const app = new App();
  addAgentCoreStacks(app, deployConfig(), COMMIT);
  const template = Template.fromStack(onlyStack(app));
  const roleId = Object.keys(template.findResources('AWS::IAM::Role')).find(id => id.includes('RuntimeExecutionRole'));
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter(policy =>
    policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId)
  );
  const actions = policies.flatMap(policy =>
    policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) =>
      [statement.Action].flat()
    )
  );

  expect(
    actions.filter(action =>
      /^(bedrock-agentcore:|logs:(GetLogEvents|FilterLogEvents|PutResourcePolicy)$)|ConfigurationBundle/.test(action)
    )
  ).toEqual([]);
  expect(template.findOutputs('LegacyRuntimeMemoryRetained')).toEqual({});
});

test('stages the session API source without the Sandbox tools virtualenv', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'session-api-staging-'));
  try {
    const source = resolve(fixture, 'source');
    mkdirSync(resolve(source, 'tools/.venv/lib'), { recursive: true });
    mkdirSync(resolve(source, 'src/botcube_harness_deepagents'), { recursive: true });
    const contractPath = 'src/botcube_harness_deepagents/session-api.json';
    const contract = JSON.stringify({ deadlines: { invocation: 840 } });
    writeFileSync(resolve(source, contractPath), contract);
    mkdirSync(resolve(source, 'artifact-check/node_modules'), { recursive: true });
    writeFileSync(resolve(source, 'artifact-check/node_modules/installed.js'), 'installed dependency');
    writeFileSync(resolve(source, 'session-api.Dockerfile'), 'FROM scratch\nCOPY src/ /src/\n');
    writeFileSync(resolve(source, 'src/session_api.py'), 'source fixture');
    writeFileSync(resolve(source, 'tools/.venv/lib/numpy-fixture.py'), 'installed dependency');
    mkdirSync(resolve(source, '.tool-dist/bot/cli'), { recursive: true });
    writeFileSync(resolve(source, '.tool-dist/bot/cli/tool.js'), 'unrelated staged CLI');
    for (const file of ['pyproject.toml', 'uv.lock']) {
      writeFileSync(resolve(source, file), file);
    }
    const app = new App({ outdir: resolve(fixture, 'out') });

    addAgentCoreStacks(app, deployConfig(), COMMIT, { harnessCodeLocation: source });

    const assets = readdirSync(app.outdir).filter(name => name.startsWith('asset.'));
    const sessionAsset = assets.find(name => existsSync(resolve(app.outdir, name, 'src/session_api.py')));
    if (sessionAsset === undefined) throw new Error('Session API asset missing');
    Template.fromStack(onlyStack(app)).hasResourceProperties('AWS::Lambda::Function', { Timeout: 840 });
    expect(readFileSync(resolve(app.outdir, sessionAsset, contractPath), 'utf8')).toBe(contract);
    expect(readFileSync(resolve(app.outdir, sessionAsset, 'src/session_api.py'), 'utf8')).toBe('source fixture');
    for (const file of ['pyproject.toml', 'uv.lock']) {
      expect(readFileSync(resolve(app.outdir, sessionAsset, file), 'utf8')).toBe(file);
    }
    expect(readFileSync(resolve(app.outdir, sessionAsset, 'session-api.Dockerfile'), 'utf8')).toBe(
      'FROM scratch\nCOPY src/ /src/\n'
    );
    expect(existsSync(resolve(app.outdir, sessionAsset, 'tools/.venv/lib/numpy-fixture.py'))).toBe(false);
    expect(existsSync(resolve(app.outdir, sessionAsset, 'artifact-check/node_modules/installed.js'))).toBe(false);
    expect(existsSync(resolve(app.outdir, sessionAsset, '.tool-dist/bot/cli/tool.js'))).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const BOT_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/bot@sha256:${'a'.repeat(64)}`;

function synthesized(config: DeployConfig): Template {
  const app = new App();
  addAgentCoreStacks(app, config, COMMIT);
  return Template.fromStack(onlyStack(app));
}

/** The runtime role's policy statements. */
function runtimeRoleStatements(template: Template): Record<string, unknown>[] {
  const roleId = Object.keys(template.findResources('AWS::IAM::Role')).find(id => id.includes('RuntimeExecutionRole'));
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
}

const pulls = (statement: Record<string, unknown>) =>
  /"(ecr:[A-Za-z]+|kms:Decrypt)"/.test(JSON.stringify(statement.Action));

describe('a Bot Image the BotCube Config names', () => {
  const built = synthesized(deployConfig());
  const named = synthesized({ ...deployConfig(), runtimeImage: BOT_IMAGE });

  test('runs on the Runtime, which keeps its logical ID', () => {
    expect(Object.keys(named.findResources('AWS::BedrockAgentCore::Runtime'))).toEqual(
      Object.keys(built.findResources('AWS::BedrockAgentCore::Runtime'))
    );
    named.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: BOT_IMAGE } },
    });
  });

  test('builds no image: no CodeBuild project, image repository or build function', () => {
    expect(built.findResources('AWS::CodeBuild::Project')).not.toEqual({});
    named.resourceCountIs('AWS::CodeBuild::Project', 0);
    named.resourceCountIs('AWS::ECR::Repository', 0);
    const functions = (template: Template) => Object.keys(template.findResources('AWS::Lambda::Function'));
    const build = (id: string) => /Container/.test(id);
    expect(functions(built).filter(build)).not.toEqual([]);
    expect(functions(named)).toEqual(functions(built).filter(id => !build(id)));
    const resources = (template: Template) => Object.keys(template.toJSON().Resources as object);
    expect(resources(named)).toEqual(resources(built).filter(id => !/Container|EcrRepository/.test(id)));
  });

  test("the Runtime may pull only that image's repository, and keeps every other grant", () => {
    expect(runtimeRoleStatements(named).filter(pulls)).toEqual([
      { Action: 'ecr:GetAuthorizationToken', Effect: 'Allow', Resource: '*' },
      {
        Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        Effect: 'Allow',
        Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/acme/bot',
      },
    ]);
    const others = (template: Template) => runtimeRoleStatements(template).filter(statement => !pulls(statement));
    expect(others(named)).toEqual(others(built));
  });

  test('keeps every other output, and the Runtime its environment, tags and network', () => {
    const outputs = (template: Template) => Object.keys(template.toJSON().Outputs as object).sort();
    expect(outputs(named)).toEqual(outputs(built).filter(id => !/ContainerUri/.test(id)));
    const properties = (template: Template) => {
      const [runtime] = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'));
      const { AgentRuntimeArtifact: _artifact, ...rest } = runtime?.Properties ?? {};
      return rest;
    };
    expect(properties(named)).toEqual(properties(built));
  });
});

type TemplateResource = { Type: string; Properties?: Record<string, unknown> };
const isTags = (name: string, value: unknown) => name.endsWith('Tags') && typeof value === 'object' && value !== null;
const tagsOf = (resource: TemplateResource) =>
  Object.entries(resource.Properties ?? {}).filter(([name, value]) => isTags(name, value));
const hasTeam = (resource: TemplateResource) => JSON.stringify(tagsOf(resource)).includes('"team"');

/** A resource without its `team` tag, in whichever tags property and form, a list or a map, CDK writes. */
function withoutTeam(resource: TemplateResource): TemplateResource {
  const properties = Object.entries(resource.Properties ?? {}).flatMap(([name, value]) => {
    if (!isTags(name, value)) return [[name, value]];
    const rest = Array.isArray(value)
      ? (value as { Key: string }[]).filter(tag => tag.Key !== 'team')
      : Object.fromEntries(Object.entries(value as object).filter(([key]) => key !== 'team'));
    return (Array.isArray(rest) ? rest.length : Object.keys(rest).length) ? [[name, rest]] : [];
  });
  return resource.Properties ? { ...resource, Properties: Object.fromEntries(properties) } : resource;
}

test('the BotCube Config tags every resource whose tags agentcore-cdk does not compose, and changes nothing else', () => {
  const untagged = synthesized(deployConfig()).toJSON().Resources as Record<string, TemplateResource>;
  const tagged = synthesized({ ...deployConfig(), tags: { team: 'cube' } }).toJSON().Resources as Record<
    string,
    TemplateResource
  >;

  expect(Object.fromEntries(Object.entries(tagged).map(([id, resource]) => [id, withoutTeam(resource)]))).toEqual(
    untagged
  );
  const gained = Object.entries(tagged).filter(([, resource]) => hasTeam(resource));
  expect(gained.length).toBeGreaterThan(0);
  const composed = ['AWS::BedrockAgentCore::Runtime', 'AWS::BedrockAgentCore::Memory'];
  expect(gained.map(([, { Type }]) => Type).filter(type => composed.includes(type))).toEqual([]);
  const missed = Object.entries(tagged).filter(([, resource]) => tagsOf(resource).length > 0 && !hasTeam(resource));
  expect([...new Set(missed.map(([, { Type }]) => Type))].sort()).toEqual(composed.sort());
});

test.each([
  [1800, 240],
  [60, 60],
  [3600, 900],
])('synthesizes the deploy identity Runtime lifecycle (%s, %s)', (maxLifetime, idleRuntimeSessionTimeout) => {
  const app = new App();
  addAgentCoreStacks(app, deployConfig({ maxLifetime, idleRuntimeSessionTimeout }), COMMIT);
  Template.fromStack(onlyStack(app)).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    LifecycleConfiguration: { MaxLifetime: maxLifetime, IdleRuntimeSessionTimeout: idleRuntimeSessionTimeout },
  });
});

test.each([
  [1800, 240],
  [60, 60],
  [3600, 900],
])('synthesizes Runtime lifecycle from botcube.yaml (%s, %s)', async (maxLifetime, idleRuntimeSessionTimeout) => {
  const root = mkdtempSync(resolve(tmpdir(), 'runtime-lifecycle-'));
  try {
    mkdirSync(resolve(root, 'deploy'));
    const base = readConfig(resolve(DEPLOY_ROOT, '../botcube.yaml'));
    writeFileSync(
      resolve(root, 'botcube.yaml'),
      JSON.stringify({
        ...base,
        agentCore: {
          ...base.agentCore,
          runtime: { ...base.agentCore?.runtime, maxLifetime, idleRuntimeSessionTimeout },
        },
      })
    );
    const config = await loadDeployConfig(resolve(root, 'deploy'), '/');
    const app = new App();
    addAgentCoreStacks(app, config, COMMIT);
    Template.fromStack(onlyStack(app)).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      LifecycleConfiguration: { MaxLifetime: maxLifetime, IdleRuntimeSessionTimeout: idleRuntimeSessionTimeout },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
