import { parkingTemplate } from './resolve-parking.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { deployIdentity } from '../lib/deploy-root.js';
import { defineProduction } from '../lib/production.js';
import { registryCredentialImage } from './credential-image.js';

const identity = deployIdentity(path.resolve(__dirname, '../../../../examples/public/deploy'));
const config = { path: path.resolve(__dirname, '../../../../examples/public/botcube.yaml') };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-cdk-'));
  roots.push(root);
  const deployRoot = path.join(root, 'deploy');
  for (const directory of ['ecs/origin-provider', 'agent-computer']) {
    fs.mkdirSync(path.join(deployRoot, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(deployRoot, 'ecs/origin-provider/index.py'), 'def handler(event, context): return {}\n');
  for (const name of ['chrome-policy.json', 'chrome-managed-policy.json']) {
    fs.writeFileSync(path.join(deployRoot, 'agent-computer', name), '{}');
  }
  const app = new App();
  return { root, deployRoot, app };
}

test.each([true, false])('synthesizes the template identity with parked=%s and local fixture assets', parked => {
  const { root, deployRoot, app } = fixture();
  const webLatency = { sessionSampleRate: 1, moments: ['first-response'] };
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, config, corsOrigins: [], webLatency,
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: registryCredentialImage('template-credentials') },
      commit: 'local-fixture',
    },
  });
  parkingTemplate(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: { MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [{ EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'], automated: [false] } }) }] }] },
  });
  for (const id of ['PrivateEgress', 'PreviewOrigin', 'ApiHealth']) {
    const template = Template.fromStack(app.node.findChild(id) as Stack).toJSON();
    expect(template.Parameters.productionMode).toEqual({ Type: 'String', AllowedValues: ['parked', 'egress', 'credential', 'live'], Description: 'Production resource mode.' });
  }
  const origin = parkingTemplate(app.node.findChild('PreviewOrigin') as Stack, parked);
  const services = origin.findResources('AWS::ECS::Service');
  const credential = Object.keys(services).find((id) => id.startsWith('CredentialService'));
  const chat = Object.entries(services).find(([id]) => id.startsWith('ChatService'))?.[1];
  expect(credential).toBeDefined();
  // Chat and Credential start together; Chat's first deletion sweep waits for Credential's health check instead.
  expect(chat?.DependsOn ?? []).not.toContain(credential);

  expect(Object.keys(origin.findResources('AWS::IAM::Policy', {
    Properties: { Roles: [identity.aws.ecs.deployRoleName] },
  }))).toHaveLength(0);
  origin.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    Roles: [identity.aws.ecs.deployRoleName],
    PolicyDocument: { Statement: [
      {
        Effect: 'Allow', Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        Resource: { 'Fn::ImportValue': Match.stringLikeRegexp('ChatStorage:.*ChatTable.*Arn') },
        Condition: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PAID_EXECUTION#origin-smoke'] },
          Null: { 'dynamodb:LeadingKeys': 'false' },
        },
      },
      {
        Effect: 'Allow', Action: 'dynamodb:UpdateItem',
        Resource: { 'Fn::ImportValue': Match.stringLikeRegexp('ChatStorage:.*ChatTable.*Arn') },
        Condition: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSIONS#acct_*'] },
          Null: { 'dynamodb:LeadingKeys': 'false' },
        },
      },
      {
        Effect: 'Allow', Action: 'bedrock-agentcore:StopRuntimeSession',
        Resource: [`arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture`,
          `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture/runtime-endpoint/DEFAULT`],
      },
    ] },
  });
  origin.resourceCountIs('AWS::ECS::Service', 2);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', parked ? 0 : 1);
  parkingTemplate(app.node.findChild('PrivateEgress') as Stack, parked).resourceCountIs('AWS::EC2::NatGateway', parked ? 0 : 1);
  expect((app.node.findChild('PreviewOrigin') as Stack).stackName).toBe(identity.aws.ecs.previewOriginStackName);
  origin.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { Name: identity.aws.agentCore.agentComputerBrowser.name });
  origin.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
    { Name: 'BOTCUBE_PARK_STATE_PARAMETER', Value: identity.ssm.parkState },
  ]) })]) });
  const parkReads = Object.values(origin.findResources('AWS::IAM::Policy'))
    .flatMap(({ Properties }) => (Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]))
    .filter(({ Action }) => Action === 'ssm:GetParameterHistory');
  expect(parkReads.map(({ Resource }) => JSON.stringify(Resource))).toEqual([expect.stringContaining(`:parameter${identity.ssm.parkState}"`)]);
});

test('a waking Credential Service passes its ALB health check as fast as Chat', () => {
  const { root, deployRoot, app } = fixture();
  const published = { ...identity, aws: { ...identity.aws, ecs: { ...identity.aws.ecs, credentialService: {
    ...identity.aws.ecs.credentialService, publicHostname: 'service.example.com', publicPaths: ['/sheets'],
  } } } };
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity: published, config, corsOrigins: [], webLatency: { sessionSampleRate: 1, moments: ['first-response'] },
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: registryCredentialImage('template-credentials') },
      commit: 'local-fixture',
    },
  });
  const groups = parkingTemplate(app.node.findChild('PreviewOrigin') as Stack, false).findResources('AWS::ElasticLoadBalancingV2::TargetGroup');
  const credential = Object.entries(groups).filter(([id]) => id.startsWith('CredentialService')).map(([, group]) => group.Properties);
  expect(credential).toEqual([expect.objectContaining({
    HealthCheckPath: '/health', Matcher: { HttpCode: '200' },
    HealthCheckIntervalSeconds: 5, HealthCheckTimeoutSeconds: 4, HealthyThresholdCount: 2, UnhealthyThresholdCount: 6,
  })]);
});

test.each([true, false])('parks idle production and wakes it from the paused page with parked=%s', parked => {
  const { root, deployRoot, app } = fixture();
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, config, corsOrigins: [], webLatency: { sessionSampleRate: 1, moments: ['first-response'] },
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: registryCredentialImage('template-credentials') },
      commit: 'local-fixture',
    },
  });
  const parking = parkingTemplate(app.node.findChild('ProductionParking') as Stack);
  const { functionName } = identity.aws.ecs.parking;
  parking.hasResourceProperties('AWS::Lambda::Function', { FunctionName: functionName, Runtime: 'nodejs24.x', Handler: 'dispatcher.handler' });
  parking.hasResourceProperties('AWS::Lambda::Function', { FunctionName: `${functionName}-wake`, Handler: 'wake.handler', ReservedConcurrentExecutions: 5 });
  parking.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE', TargetFunctionArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^wake'), 'Arn'] } });
  parking.hasResourceProperties('AWS::Events::Rule', { State: identity.aws.ecs.parking.autoPark ? 'ENABLED' : 'DISABLED', ScheduleExpression: 'rate(5 minutes)', Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^dispatcher'), 'Arn'] }, Input: '{"op":"check"}' })] });
  parking.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    StartingPosition: 'LATEST', MaximumRetryAttempts: 0,
    FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ['INSERT'], dynamodb: { Keys: { pk: { S: ['PRODUCTION_PARKING'] }, sk: { S: [{ prefix: 'DISPATCH#' }] } } } }) }] },
  });
  const policies = Object.values(parking.findResources('AWS::IAM::Policy')) as { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: { Action: string | string[]; Condition?: unknown }[] } } }[];
  const rolesAllowed = (action: string) => policies.filter(({ Properties }) => Properties.PolicyDocument.Statement.some(({ Action }) => [Action].flat().includes(action)))
    .flatMap(({ Properties }) => Properties.Roles.map(({ Ref }) => Ref.replace(/[A-F0-9]{8}$/, '')));
  expect(rolesAllowed('secretsmanager:GetSecretValue')).toEqual(['TransitionServiceRole']);
  parking.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameters', Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }) })]) } });
  for (const metric of ['ExecutionsFailed', 'ExecutionsTimedOut', 'ExecutionsAborted']) {
    parking.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: 'primary + backup + monitoring' }),
        ...['TransitionStateMachine', 'PartialModeBackstop', 'MonitoringProof'].map(prefix => Match.objectLike({
          MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: metric,
            Dimensions: [{ Name: 'StateMachineArn', Value: { Ref: Match.stringLikeRegexp(`^${prefix}`) } }],
          }) }),
        })),
      ]),
      Threshold: 1, EvaluationPeriods: 1, AlarmActions: [{ 'Fn::Join': Match.anyValue() }],
    });
  }
  const monitoring = Object.values(parking.findResources('AWS::StepFunctions::StateMachine'))
    .find(resource => resource.Properties.StateMachineName === `${functionName}-monitoring`);
  expect(monitoring).toBeDefined();
  const definition = JSON.stringify(monitoring);
  for (const expected of ['EstablishMonitoring', 'ReportMonitoringFailure', 'MonitoringFailed',
    'sns:publish', 'Production monitoring proof failed', 'TimeoutSeconds', '660', '720', 'CausePath', 'ErrorPath']) {
    expect(definition).toContain(expected);
  }
  expect(definition).not.toContain('Retry');
  parking.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  const machine = Object.values(parking.findResources('AWS::StepFunctions::StateMachine'))[0];
  expect(JSON.stringify(machine)).toContain('TransientServiceError');
  expect(JSON.stringify(machine)).toContain('MaxAttempts\\\":3');
  expect(JSON.stringify(parking.findResources('AWS::CloudWatch::Alarm'))).toContain(identity.aws.ecs.alertsTopicName);
  expect(JSON.stringify(parking.findResources('AWS::IAM::Policy'))).toContain('parameter/cdk-bootstrap/hnb659fds/version');
  expect(rolesAllowed('dynamodb:PutItem')).toEqual(['wakeServiceRole']);
  for (const { Properties } of policies) {
    for (const statement of Properties.PolicyDocument.Statement.filter(({ Action }) => [Action].flat().some(action => /^dynamodb:(Get|Put|Update|Delete)Item$|^dynamodb:Query$/.test(action)))) {
      expect(statement.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PRODUCTION_PARKING'] } });
    }
  }
  parkingTemplate(app.node.findChild('ChatStorage') as Stack).hasResourceProperties('AWS::DynamoDB::Table', { StreamSpecification: { StreamViewType: 'NEW_IMAGE' } });
  expect(Object.values(parking.toJSON().Outputs as Record<string, { Export?: { Name: string } }>).map(({ Export }) => Export?.Name))
    .toContain('ProductionParking:ExportsOutputFnGetAttwakeFunctionUrlA2A050A1FunctionUrl3B1B4F3E');
  const origin = parkingTemplate(app.node.findChild('PreviewOrigin') as Stack, parked);
  if (parked) origin.hasResourceProperties('AWS::CloudFormation::CustomResource', { Kind: 'ParkedWorker', WakeUrl: Match.anyValue(), Script: Match.stringLikeRegexp('^[0-9a-f]{64}$') });
  const chatEnvironment = Object.values(origin.findResources('AWS::ECS::TaskDefinition'))
    .flatMap(({ Properties }) => Properties.ContainerDefinitions as { Name: string; Environment?: { Name: string }[] }[])
    .filter(({ Name }) => Name === 'chat-service')
    .flatMap(({ Environment }) => (Environment ?? []).map(({ Name }) => Name));
  expect(chatEnvironment).toContain('BOTCUBE_PARK_STATE_PARAMETER');
  expect(chatEnvironment).not.toContain('BOTCUBE_REPORT_ACTIVITY');
});
test.each([true, false])('composition names adopter-owned networks and browser role with parked=%s', parked => {
  const { root, deployRoot, app } = fixture();
  const webLatency = { sessionSampleRate: 1, moments: ['first-response'] };
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, config, corsOrigins: [], webLatency,
    storage: { tableName: 'adopter-chat' },
    originConfig: {
      securityGroupName: 'adopter-origin-ingress',
      agentNetworkSecurityGroupName: 'adopter-agent-network',
      agentComputerSecurityGroupName: 'adopter-browser-network',
      agentComputerBrowserRoleName: 'adopter-browser-role',
    },
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', filesWorkspace: '/mnt/corporate/files', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: registryCredentialImage('template-credentials') },
      commit: 'local-fixture',
    },
  });
  parkingTemplate(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: { MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [{ EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'], automated: [false] } }) }] }] },
  });
  const origin = parkingTemplate(app.node.findChild('PreviewOrigin') as Stack, parked);
  const storage = parkingTemplate(app.node.findChild('ChatStorage') as Stack);
  storage.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'adopter-chat' });
  for (const name of ['adopter-origin-ingress', 'adopter-agent-network', 'adopter-browser-network']) {
    origin.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: name });
  }
  origin.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-browser-role' });
  origin.resourceCountIs('AWS::ECS::Service', 2);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', parked ? 0 : 1);
  parkingTemplate(app.node.findChild('PrivateEgress') as Stack, parked).resourceCountIs('AWS::EC2::NatGateway', parked ? 0 : 1);
  expect((app.node.findChild('PreviewOrigin') as Stack).stackName).toBe(identity.aws.ecs.previewOriginStackName);
  origin.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { Name: identity.aws.agentCore.agentComputerBrowser.name });
  const chatEnvironment = Object.values(origin.findResources('AWS::ECS::TaskDefinition'))
    .flatMap(({ Properties }) => Properties.ContainerDefinitions as { Name: string; Environment?: { Name: string }[] }[])
    .filter(({ Name }) => Name === 'chat-service')
    .flatMap(({ Environment }) => (Environment ?? []).map(({ Name }) => Name));
  expect(chatEnvironment).toContain('BOTCUBE_PUBLIC_ORIGIN');
  origin.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Name: 'chat-service', Environment: Match.arrayWith([
      { Name: 'BOTCUBE_WORKSPACE', Value: '/mnt/corporate/files' },
    ]) })]),
  });
  expect(chatEnvironment).toContain('BOTCUBE_CONFIG');
});

test('composition rejects competing chat table names before creating resources', () => {
  expect(() => defineProduction(new App(), {
    repositoryRoot: '/unused', deployRoot: '/unused', identity, config, corsOrigins: [],
    chatTableName: 'legacy-chat', storage: { tableName: 'configured-chat' },
  })).toThrow('Choose chatTableName or storage.tableName, not both');
});

test.each([
  ['parked', 0, 0, 0],
  ['egress', 1, 0, 0],
  ['credential', 1, 1, 0],
  ['live', 1, 1, 1],
] as const)('production resource table in %s mode', (mode, nat, credentials, chat) => {
  const { root, deployRoot, app } = fixture();
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, config, corsOrigins: [],
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', turnIdentityKeysVersion: 'key-revision', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: registryCredentialImage('template-credentials') },
      commit: 'local-fixture',
    },
  });
  const origin = parkingTemplate(app.node.findChild('PreviewOrigin') as Stack, mode);
  const egress = parkingTemplate(app.node.findChild('PrivateEgress') as Stack, mode);
  egress.resourceCountIs('AWS::EC2::NatGateway', nat);
  egress.resourceCountIs('AWS::EC2::Route', nat);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', chat);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', chat);
  const services = Object.values(origin.findResources('AWS::ECS::Service')).map(resource => resource.Properties);
  expect(services.find(service => service.ServiceName === 'chat-service-preview').DesiredCount).toBe(chat);
  expect(services.find(service => service.ServiceName === 'credential-service').DesiredCount).toBe(credentials);
  if (!chat) origin.hasResourceProperties('AWS::CloudFormation::CustomResource', {
    Kind: 'ParkedWorker', KeyVersion: 'key-revision', TurnIdentityKeysSecret: identity.aws.ecs.chatService.turnIdentityKeysSecretName,
  });
  const health = parkingTemplate(app.node.findChild('ApiHealth') as Stack, mode);
  health.resourceCountIs('AWS::CloudWatch::Alarm', chat);
  if (chat) health.hasResourceProperties('AWS::CloudWatch::Alarm', { ActionsEnabled: true });
  origin.resourceCountIs('AWS::CloudWatch::Alarm', chat ? 12 : credentials ? 4 : 1);
});

type Resource = { Properties?: Record<string, unknown> };
const isTags = (name: string, value: unknown) => name.endsWith('Tags') && typeof value === 'object' && value !== null;

/** A resource without its `team` tag, in whichever tags property (Tags, FileSystemTags, ...) and form, a list or a map, CDK writes. */
function withoutTeam(resource: Resource): Resource {
  const properties = Object.entries(resource.Properties ?? {}).flatMap(([name, value]) => {
    if (!isTags(name, value)) return [[name, value]];
    const rest = Array.isArray(value)
      ? value.filter((tag: { Key: string }) => tag.Key !== 'team')
      : Object.fromEntries(Object.entries(value as object).filter(([key]) => key !== 'team'));
    return (Array.isArray(rest) ? rest.length : Object.keys(rest).length) ? [[name, rest]] : [];
  });
  return resource.Properties ? { ...resource, Properties: Object.fromEntries(properties) } : resource;
}

const tagsOf = (resource: Resource) => Object.entries(resource.Properties ?? {}).filter(([name, value]) => isTags(name, value));
const hasTeam = (resource: Resource) => JSON.stringify(tagsOf(resource)).includes('"team"');

test('the BotCube Config tags every taggable resource of every stack, and changes nothing else', () => {
  const stacks = (tags?: Record<string, string>) => {
    const { root, deployRoot, app } = fixture();
    defineProduction(app, {
      repositoryRoot: root, deployRoot, identity, config, corsOrigins: [], webLatency: { sessionSampleRate: 1, moments: ['first-response'] },
      ...(tags ? { tags } : {}),
      origin: {
        input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
        images: { chat: ContainerImage.fromRegistry('template-chat'), credential: registryCredentialImage('template-credentials') },
        commit: 'local-fixture',
      },
    });
    return Object.fromEntries(app.node.children.filter(Stack.isStack).map(stack => [stack.node.id, Template.fromStack(stack).toJSON().Resources as Record<string, Resource>]));
  };
  const untagged = stacks();
  const tagged = stacks({ team: 'cube' });

  expect(Object.keys(tagged)).toEqual(Object.keys(untagged));
  for (const [id, resources] of Object.entries(tagged)) {
    expect([id, Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, withoutTeam(resource)]))]).toEqual([id, untagged[id]]);
    expect([id, Object.values(resources).some(hasTeam)]).toEqual([id, true]);
    const missed = Object.entries(resources).filter(([, resource]) => tagsOf(resource).length > 0 && !hasTeam(resource));
    expect([id, missed.map(([key]) => key)]).toEqual([id, []]);
  }
});
