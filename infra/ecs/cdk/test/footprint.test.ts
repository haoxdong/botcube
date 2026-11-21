// Test seam 2 (ADR 0091): each example's infrastructure grants exactly what `botcube footprint` prints for its Deployment Config.
import { ok as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { footprint, IMAGES } from '../../../../deployment-config/footprint.js';
import type { Principal } from '../../../../deployment-config/principals.js';
import { loadDeployment } from '../../../../deployment-config/load.js';
import { CREDENTIAL_IMAGE_EXAMPLES_ROOT, EXAMPLES_ROOT, IMAGE_EXAMPLES_ROOT } from '../example/app.js';
import { deployIdentity } from '../lib/deploy-root.js';
import { deploymentConfigPath, synthesizeExample } from './example-fixture.js';
import { parkingTemplate } from './resolve-parking.js';

const EXAMPLES = ['public', 'enterprise'];
/**
 * The inbound auth each example's Runtime takes: SigV4 by default, or only the Chat Service's bearer tokens, checked
 * against the discovery document it serves at its public origin (the deploy identity's chatService domain).
 */
const RUNTIME_AUTHORIZERS: Record<string, unknown[]> = {
  public: [undefined],
  enterprise: [{ CustomJWTAuthorizer: { DiscoveryUrl: 'https://localhost/.well-known/openid-configuration', AllowedAudience: ['botcube-harness'] } }],
};
const AGENTCORE_STACK = 'AgentCore-bot-cube-template';
/**
 * The hosts beyond AWS each example's processes are configured to reach, read from the Deployment Config by hand: the
 * enterprise example's OIDC issuer, model endpoint, OTLP collector and proxy.
 */
const CONFIGURED_EGRESS: Record<string, string[]> = {
  public: [],
  enterprise: ['login.example.com', 'models.example.com', 'otel-collector.example.com:4318', 'proxy.example.com:3128'],
};
/** Hosts BotCube's own code names under every config, so no deployed setting shows them: AWS APIs and Plan Usage's OpenAI hosts. */
const codeNamed = (host: string) => host.endsWith('.<region>.amazonaws.com') || ['api.openai.com', 'auth.openai.com'].includes(host);

/** Where the hosts the deployment is configured to reach and the footprint's hosts beyond code-named ones differ, each way. */
function egressDrift(printed: string[], configured: string[]) {
  const beyondCode = printed.filter(host => !codeNamed(host));
  return {
    configuredNotPrinted: configured.filter(host => !beyondCode.includes(host)),
    printedNotConfigured: beyondCode.filter(host => !configured.includes(host)),
  };
}
const EXAMPLE_IDENTITY = deployIdentity(path.resolve(__dirname, '../../../../examples/public/deploy'));

/** Each runtime role BotCube creates, by construct path, and the footprint principal it is. */
const PRINCIPAL_ROLES: Partial<Record<string, Principal>> = {
  'PreviewOrigin/ChatService/Task/TaskRole': 'chatService',
  'PreviewOrigin/CredentialService/Task/TaskRole': 'credentialService',
  'PreviewOrigin/ChatService/ScheduledRunsRole': 'scheduledRuns',
  'PreviewOrigin/AgentComputerBrowserRole': 'agentComputerBrowser',
  'PreviewOrigin/FilesMountRole': 'filesMount',
  'PreviewOrigin/CredentialService/AuditCopy/ServiceRole': 'auditCopy',
  [`${AGENTCORE_STACK}/Application/AgentBotCube/Runtime/ExecutionRole`]: 'harness',
  [`${AGENTCORE_STACK}/SessionApiRole`]: 'sessionApi',
  [`${AGENTCORE_STACK}/UserMemoryRole`]: 'userMemory',
};

/** Roles and policies only the deploy machinery uses: hosting, ops and custom resources, outside the footprint. */
const MACHINERY_STACKS = ['ApiHealth', 'WebLatency', 'ProductionParking', 'PrivateEgress', 'ChatStorage'];
const MACHINERY = new Set([
  'PreviewOrigin/on_event/ServiceRole', 'PreviewOrigin/is_complete/ServiceRole',
  'PreviewOrigin/OriginProvider/framework-onEvent/ServiceRole', 'PreviewOrigin/OriginProvider/framework-isComplete/ServiceRole',
  'PreviewOrigin/OriginProvider/framework-onTimeout/ServiceRole', 'PreviewOrigin/OriginProvider/waiter-state-machine/Role',
  'PreviewOrigin/OriginSmokePolicy',
  'PreviewOrigin/ChatService/Task/ExecutionRole', 'PreviewOrigin/CredentialService/Task/ExecutionRole',
  ...['onEvent', 'isComplete', 'worker'].map(handler => `PreviewOrigin/FilesPool/${handler}/ServiceRole`),
  ...['framework-onEvent', 'framework-isComplete', 'framework-onTimeout'].map(handler => `PreviewOrigin/FilesPool/Provider/${handler}/ServiceRole`),
  'PreviewOrigin/FilesPool/Provider/waiter-state-machine/Role',
  `${AGENTCORE_STACK}/Application/MemoryBotCube/ExecutionRole`,
  `${AGENTCORE_STACK}/Application/AgentBotCube/ContainerImageBuilder/ContainerBuildHandler/ServiceRole`,
  `${AGENTCORE_STACK}/ContainerBuildProject/ContainerBuildExecutionRole`,
  `${AGENTCORE_STACK}/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole`,
]);

interface Granted { actions: string[]; managedPolicies: string[] }
interface PolicyDocument { Statement: { Effect: string; Action: string | string[] }[] }
type ManagedPolicyArn = string | { 'Fn::Join': [string, unknown[]] };
/** The template properties this check reads, of the resource types it reads them on. */
interface Properties {
  ManagedPolicyArns?: ManagedPolicyArn[];
  Policies?: { PolicyDocument: PolicyDocument }[];
  PolicyDocument?: PolicyDocument;
  Roles?: (string | { Ref: string })[];
  ContainerDefinitions?: { Image: string; Environment?: { Name: string; Value: unknown }[] }[];
  EnvironmentVariables?: Record<string, unknown>;
  Role?: { 'Fn::GetAtt': [string, string] };
  LoggingConfig?: { LogGroup?: { Ref: string } };
}

type Resources = Record<string, { Type: string; Properties: Properties }>;

/** What each footprint principal is granted and which images run, across the stacks BotCube's runtime lives in. */
function granted(app: App) {
  const grants: [Principal, Granted][] = [];
  const images: string[] = [];
  const egressHosts: string[] = [];
  for (const stack of app.node.children.filter((child): child is Stack => child instanceof Stack)) {
    if (MACHINERY_STACKS.includes(stack.node.id)) continue;
    const template = stack.node.id === 'PreviewOrigin' ? parkingTemplate(stack, 'live') : Template.fromStack(stack);
    const resources = template.toJSON().Resources as Resources;
    grants.push(...principalGrants(resources, principalsById(stack)));
    images.push(...imagesIn(resources));
    egressHosts.push(...configuredHosts(resources));
  }
  const iamByPrincipal: Partial<Record<Principal, Granted>> = {};
  for (const [principal, { actions, managedPolicies }] of grants.filter(([, { actions, managedPolicies }]) => actions.length + managedPolicies.length > 0)) {
    const grant = (iamByPrincipal[principal] ??= { actions: [], managedPolicies: [] });
    grant.actions = sorted([...grant.actions, ...actions]);
    grant.managedPolicies = sorted([...grant.managedPolicies, ...managedPolicies]);
  }
  return { iam: iamByPrincipal, images: sorted(images), egressHosts: sorted(egressHosts) };
}

const sorted = (values: string[]) => [...new Set(values)].sort();

/** The principal each role and managed policy is, by logical ID, failing on one that is neither a principal nor machinery. */
function principalsById(stack: Stack): Map<string, Principal | undefined> {
  const holders = stack.node.findAll().filter(construct => construct instanceof iam.Role || construct instanceof iam.ManagedPolicy)
    .map(construct => [stack.getLogicalId(construct.node.defaultChild as iam.CfnRole), construct.node.path] as const);
  const unknown = holders.map(([, path]) => path).filter(path => !(path in PRINCIPAL_ROLES || MACHINERY.has(path)));
  assert(unknown.length === 0, `Neither a footprint principal nor deploy machinery: ${unknown.join(', ')}`);
  return new Map(holders.map(([logicalId, path]) => [logicalId, PRINCIPAL_ROLES[path]]));
}

function principalGrants(resources: Resources, principals: Map<string, Principal | undefined>): [Principal, Granted][] {
  const to = (roleId: string, actions: string[], managedPolicies: string[] = []): [Principal, Granted][] => {
    const principal = principals.get(roleId);
    return principal ? [[principal, { actions, managedPolicies }]] : [];
  };
  return Object.entries(resources).flatMap(([logicalId, { Type, Properties }]) => {
    if (Type === 'AWS::IAM::Role') {
      return to(logicalId, (Properties.Policies ?? []).flatMap(policy => actions(policy.PolicyDocument)),
        (Properties.ManagedPolicyArns ?? []).map(managedPolicyName));
    }
    const document = Properties.PolicyDocument;
    if (!['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(Type) || !document) return [];
    // An imported role appears by name; BotCube's runtime roles are its own, so they appear as a Ref.
    return (Properties.Roles ?? []).flatMap(role => (typeof role === 'string' ? [] : to(role.Ref, actions(document))));
  });
}

const OWN_HOSTS = new Set([EXAMPLE_IDENTITY.domains.chatService, EXAMPLE_IDENTITY.domains.chatServicePreview,
  ...EXAMPLES.flatMap(example => {
    const { web, supplied } = loadDeployment(deploymentConfigPath(example)).config;
    return [...(web?.corsOrigins ?? []), ...(supplied?.credentialService ? [supplied.credentialService.url] : [])];
  })].map(origin => new URL(origin).host));
const isOwn = ({ host, hostname }: URL) =>
  OWN_HOSTS.has(host) || ['localhost', '127.0.0.1', '[::1]', 'task-address'].includes(hostname) || hostname.endsWith(`.${EXAMPLE_IDENTITY.aws.ecs.privateNamespace}`);

/**
 * The hosts the containers' and Runtimes' environment names, and the Deployment Config file it points each process
 * at, other than the deployment's own origins, loopback and its private namespace: where its processes are configured
 * to reach beyond the AWS APIs their roles name.
 */
function configuredHosts(resources: Resources): string[] {
  return Object.values(resources).flatMap(({ Type, Properties }) => {
    const variables: [string, unknown][] = Type === 'AWS::ECS::TaskDefinition'
      ? (Properties.ContainerDefinitions ?? []).flatMap(container => (container.Environment ?? []).map(({ Name, Value }) => [Name, Value] as [string, unknown]))
      : Type === 'AWS::BedrockAgentCore::Runtime' ? Object.entries(Properties.EnvironmentVariables ?? {}) : [];
    const values = variables.map(([name, value]) => (name === 'BOTCUBE_DEPLOYMENT_CONFIG' ? servedDeploymentConfig(value) : value));
    return values.filter((value): value is string => typeof value === 'string')
      .flatMap(value => value.match(/\b(?:https?|wss?):\/\/[^\s"',;]+/g) ?? [])
      .filter(url => URL.canParse(url)).map(url => new URL(url)).filter(url => !isOwn(url)).map(url => url.host);
  });
}

/** The text of the Deployment Config at `imagePath` in the chat or Credential Service image, which ships it from botcube/examples/. */
function servedDeploymentConfig(imagePath: unknown): string {
  const root = [IMAGE_EXAMPLES_ROOT, CREDENTIAL_IMAGE_EXAMPLES_ROOT].find(prefix => typeof imagePath === 'string' && imagePath.startsWith(`${prefix}/`));
  assert(typeof imagePath === 'string' && root !== undefined, `${JSON.stringify(imagePath)} is under ${IMAGE_EXAMPLES_ROOT} or ${CREDENTIAL_IMAGE_EXAMPLES_ROOT}`);
  return fs.readFileSync(path.join(EXAMPLES_ROOT, path.posix.relative(root, imagePath)), 'utf8');
}

function imagesIn(resources: Resources): string[] {
  return Object.values(resources).flatMap(({ Type, Properties }) => {
    if (Type === 'AWS::ECS::TaskDefinition') return (Properties.ContainerDefinitions ?? []).map(container => container.Image);
    // The Runtime runs the bot's image, which AgentCore builds from the bot's Harness image.
    return Type === 'AWS::BedrockAgentCore::Runtime' ? [IMAGES.bot] : [];
  });
}

function actions(document: PolicyDocument): string[] {
  return document.Statement.filter(statement => statement.Effect === 'Allow').flatMap(statement => [statement.Action].flat());
}

/** `AWSLambdaBasicExecutionRole` from `arn:${Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`. */
function managedPolicyName(arn: ManagedPolicyArn): string {
  const parts = typeof arn === 'string' ? [arn] : arn['Fn::Join'][1];
  const last = parts[parts.length - 1];
  assert(typeof last === 'string' && last.includes(':iam::aws:policy/'), `${JSON.stringify(arn)} is an AWS managed policy`);
  return last.slice(last.lastIndexOf('/') + 1);
}

const apps = new Map<string, Promise<App>>();
/** Each example synthesized once, from its Deployment Config through the examples' deploy entry. */
function appOf(example: string): Promise<App> {
  const app = apps.get(example) ?? synthesizeExample(example);
  apps.set(example, app);
  return app;
}

describe.each(EXAMPLES)('the %s example', example => {
  const needs = footprint(loadDeployment(deploymentConfigPath(example)).config);
  let synthesized: ReturnType<typeof granted>;
  let pooled: ReturnType<typeof granted>;
  beforeAll(async () => {
    synthesized = granted(await appOf(example));
    pooled = granted(await synthesizeExample(example, undefined, { filesAccessPointMode: 'pool' }));
  }, 120_000);

  test('grants each BotCube role exactly the IAM actions its footprint prints', () => {
    expect(synthesized.iam).toEqual(needs.iam);
  });

  test('grants each BotCube role exactly the IAM actions its footprint prints with Files access points from the deploy-time pool', () => {
    expect(pooled.iam).toEqual(footprint(loadDeployment(deploymentConfigPath(example)).config, { filesAccessPointMode: 'pool' }).iam);
  });

  test('holds no AWS managed policy on any Lambda role: each function writes its own log group by an inline grant it deploys after', async () => {
    const stacks = (await appOf(example)).node.findAll().filter(Stack.isStack);
    const strays = stacks.flatMap(stack => {
      const resources = Template.fromStack(stack).toJSON().Resources as Record<string, Resources[string] & { DependsOn?: string[] }>;
      const logsPolicy = (roleId: string | undefined, logGroupId: string | undefined) => Object.entries(resources).find(([, { Type, Properties }]) => Type === 'AWS::IAM::Policy'
        && JSON.stringify(Properties.Roles).includes(`"${roleId}"`)
        && (Properties.PolicyDocument?.Statement ?? []).some(statement => [statement.Action].flat().includes('logs:PutLogEvents') && JSON.stringify(statement).includes(`"${logGroupId}"`)))?.[0];
      return Object.entries(resources).filter(([, { Type }]) => Type === 'AWS::Lambda::Function').flatMap(([logicalId, { Properties, DependsOn = [] }]) => {
        const roleId = Properties.Role?.['Fn::GetAtt'][0];
        const policy = logsPolicy(roleId, Properties.LoggingConfig?.LogGroup?.Ref);
        const managed = roleId ? resources[roleId]?.Properties.ManagedPolicyArns : undefined;
        return managed || !policy || !DependsOn.includes(policy) ? [`${stack.node.path}/${logicalId}`] : [];
      });
    });
    expect(strays).toEqual([]);
  });

  test('runs exactly the images its footprint prints', () => {
    expect(synthesized.images).toEqual(needs.images);
  });

  test('is configured to reach beyond AWS exactly the egress hosts its footprint prints', () => {
    expect(synthesized.egressHosts).toEqual(CONFIGURED_EGRESS[example]);
    expect(egressDrift(needs.egressHosts, synthesized.egressHosts)).toEqual({ configuredNotPrinted: [], printedNotConfigured: [] });
  });

  test('admits to its Runtime only the callers its Harness auth names', async () => {
    const runtimes = Template.fromStack((await appOf(example)).node.findChild(AGENTCORE_STACK) as Stack).findResources('AWS::BedrockAgentCore::Runtime');
    expect(Object.values(runtimes).map(runtime => runtime.Properties.AuthorizerConfiguration)).toEqual(RUNTIME_AUTHORIZERS[example]);
  });
});

describe('the egress comparison', () => {
  const printed = ['api.openai.com', 'login.example.com', 'sts.<region>.amazonaws.com'];

  test('reports a configured host the footprint does not print', () => {
    expect(egressDrift(printed, ['login.example.com', 'unprinted.example.com']))
      .toEqual({ configuredNotPrinted: ['unprinted.example.com'], printedNotConfigured: [] });
  });

  test('reports a printed host beyond AWS that nothing is configured to reach', () => {
    expect(egressDrift(printed, [])).toEqual({ configuredNotPrinted: [], printedNotConfigured: ['login.example.com'] });
  });
});

test("the enterprise example's Chat Service assumes the AgentCore stack's Memory role for each Turn", async () => {
  const chat = parkingTemplate((await appOf('enterprise')).node.findChild('PreviewOrigin') as Stack, 'live');
  const roleArn = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::000000000000:role/bot-cube-user-memory']] };

  chat.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([{ Name: 'BOTCUBE_USER_MEMORY_ROLE_ARN', Value: roleArn }]) })]),
  });
  chat.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: Match.arrayWith([{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: roleArn }]) },
  });
}, 120_000);

test("the enterprise example's Chat Service, Credential Service and Runtime read its models Endpoint from the Deployment Config, not the environment", async () => {
  const app = await appOf('enterprise');
  const origin = parkingTemplate(app.node.findChild('PreviewOrigin') as Stack, 'live');
  const environments = Object.entries(origin.findResources('AWS::ECS::TaskDefinition'))
    .map(([logicalId, task]) => [logicalId.replace(/[0-9A-F]{8}$/, ''), ((task.Properties as Properties).ContainerDefinitions ?? []).flatMap(container => (container.Environment ?? []).map(({ Name }) => Name))] as const);
  const [runtime] = Object.values(Template.fromStack(app.node.findChild(AGENTCORE_STACK) as Stack).findResources('AWS::BedrockAgentCore::Runtime'));
  const runtimeVariables = Object.keys((runtime.Properties as Properties).EnvironmentVariables ?? {});
  const models = (name: string) => name.startsWith('BOTCUBE_MODELS_') || name === 'BOTCUBE_TURN_SUMMARY_MODEL';

  expect(environments.filter(([, names]) => names.includes('BOTCUBE_DEPLOYMENT_CONFIG')).map(([task]) => task)).toEqual(['ChatServiceTask', 'CredentialServiceTask']);
  expect([...environments.flatMap(([, names]) => names), ...runtimeVariables].filter(models)).toEqual([]);
});
