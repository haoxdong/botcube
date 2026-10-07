import { ok as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, AssetStaging, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { cartridgeDeployRoot } from '../lib/cartridge.js';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { defineProduction, parkedContext, type ProductionOptions } from '../lib/production.js';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const deployRoot = cartridgeDeployRoot();
const identity = JSON.parse(fs.readFileSync(path.join(deployRoot, 'identity.json'), 'utf8'));
const chatKeys = identity.aws.ecs.chatService.environmentKeys;
const budgets = JSON.parse(fs.readFileSync(path.join(deployRoot, '..', 'latency-budgets.json'), 'utf8'));

const productionStates = new Map<boolean, ReturnType<typeof createProduction>>();

function synthProduction(parked: boolean) {
  let production = productionStates.get(parked);
  if (!production) {
    production = createProduction(parked);
    productionStates.set(parked, production);
  }
  return production;
}

function createProduction(parked: boolean, configuration: Pick<ProductionOptions, 'chat' | 'credentials'> = {}) {
  const app = new App();
  defineProduction(app, {
    repositoryRoot, deployRoot, identity, parked, ...configuration,
    origin: {
      input: { cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', memoryId: 'test_memory-AbCdEfGhIj', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/test-runtime` },
      images: { chat: ContainerImage.fromRegistry('chat-image'), credential: ContainerImage.fromRegistry('credential-image') },
      commit: 'abc123',
    },
  });
  const stack = (id: string) => Template.fromStack(app.node.findChild(id) as never);
  const deployedAfter = (id: string) => (app.node.findChild(id) as Stack).dependencies.map(dependency => dependency.node.id);
  return { app, storage: stack('ChatStorage'), egress: stack('PrivateEgress'), origin: stack('PreviewOrigin'), health: stack('ApiHealth'), deployedAfter };
}

test.each([['true', true], ['false', false]])('parked context %j reads as %j', (value, parked) => {
  expect(parkedContext(value)).toBe(parked);
});

test.each([undefined, '', 'yes', 'False', 1, true])('parked context %j fails synthesis', value => {
  expect(() => parkedContext(value)).toThrow('Context parked must be true or false');
});

const SERVING = ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::ListenerRule'];

function services(template: Template) {
  return Object.values(template.findResources('AWS::ECS::Service')).map(service => service.Properties);
}

test('Parked removes the ALB and its listener', () => {
  const { origin } = synthProduction(true);
  for (const type of SERVING) origin.resourceCountIs(type, 0);
  // An empty list is how CloudFormation removes the association in place (no service replacement).
  const [chat, credential] = services(origin);
  expect(chat.LoadBalancers).toEqual([]);
  expect(credential.LoadBalancers).toBeUndefined();
});

test('Parked removes the NAT Gateway and its default route', () => {
  const { egress } = synthProduction(true);
  egress.resourceCountIs('AWS::EC2::NatGateway', 0);
  egress.resourceCountIs('AWS::EC2::Route', 0);
});

test('Parked scales both services to 0 and disables the reaper schedule', () => {
  const { origin } = synthProduction(true);
  expect(services(origin).map(service => [service.ServiceName, service.DesiredCount])).toEqual([['chat-service-preview', 0], ['credential-service', 0]]);
  origin.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(5 minutes)', State: 'DISABLED' });
});

test('Live serves through the ALB and NAT Gateway with one task per service and the reaper on', () => {
  const { origin, egress } = synthProduction(false);
  for (const type of ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::Listener', 'AWS::ElasticLoadBalancingV2::TargetGroup']) origin.resourceCountIs(type, 1);
  // The forward rule, and the rule that keeps the Agent Computer CDP channel off the public ALB.
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
  origin.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', { Conditions: [{ Field: 'host-header', HostHeaderConfig: {
    Values: [identity.domains.chatServicePreview, identity.domains.chatService].map((url: string) => new URL(url).hostname),
  } }] });
  origin.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/agent-computer/cdp*'] } }],
    Actions: [Match.objectLike({ Type: 'fixed-response' })],
  });
  egress.resourceCountIs('AWS::EC2::NatGateway', 1);
  egress.resourceCountIs('AWS::EC2::Route', 1);
  expect(services(origin).map(service => [service.ServiceName, service.DesiredCount, service.LoadBalancers?.length])).toEqual([['chat-service-preview', 1, 1], ['credential-service', 1, undefined]]);
  origin.hasResourceProperties('AWS::Events::Rule', { State: 'ENABLED' });
});

test.each([true, false])('production parked=%s overrides conflicting nested service settings', parked => {
  const { origin, egress } = createProduction(parked, {
    chat: { parked: !parked }, credentials: { parked: !parked },
  });
  expect(services(origin).map(service => service.DesiredCount)).toEqual(parked ? [0, 0] : [1, 1]);
  origin.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(5 minutes)', State: parked ? 'DISABLED' : 'ENABLED' });
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', parked ? 0 : 1);
  egress.resourceCountIs('AWS::EC2::NatGateway', parked ? 0 : 1);
});

test('each serving task definition, and only those, records the deployed commit for scripts/dev-status.sh', () => {
  const { origin } = synthProduction(false);
  const tagged = Object.values(origin.findResources('AWS::ECS::TaskDefinition'))
    .filter(task => task.Properties.Tags?.some((tag: { Key: string; Value: string }) => tag.Key === 'commit' && tag.Value === 'abc123'))
    .map(task => task.Properties.ContainerDefinitions[0].Name);
  expect(tagged.sort()).toEqual(['chat-service', 'credential-service']);
  expect(Object.values(origin.findResources('AWS::IAM::Role')).some(role => role.Properties.Tags)).toBe(false);
});

test('the reaper task runs the TypeScript reaper bundle from the Chat Service image', () => {
  const { origin } = synthProduction(false);
  origin.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [Match.objectLike({ Image: 'chat-image', Command: ['node', 'dist/reap-auth-browsers.js'] })],
  });
});

test('Plan Usage owner identity comes from the trusted deployment parameter', () => {
  const { origin } = synthProduction(false);
  const parameters = origin.toJSON().Parameters;
  const owner = Object.entries(parameters).find(([, parameter]) =>
    (parameter as { Default?: string }).Default === identity.aws.ecs.chatService.planUsageOwnerAccountParameter);
  assert(owner);
  for (const Image of ['chat-image', 'credential-image']) {
    origin.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [Match.objectLike({ Image, Environment: Match.arrayWith([
        { Name: chatKeys.planUsageOwnerAccountId, Value: { Ref: owner[0] } },
      ]) })],
    });
  }
});

test.each([true, false])('parked=%s keeps the Elastic IP, certificates, trust store, namespace, tables and KMS key', parked => {
  const { storage, egress, origin } = synthProduction(parked);
  const retained = (template: Template, type: string) => Object.values(template.findResources(type)).map(resource => resource.DeletionPolicy);
  expect(retained(egress, 'AWS::EC2::EIP')).toEqual(['Retain']);
  expect(retained(storage, 'AWS::DynamoDB::Table')).toEqual(['Retain']);
  expect(retained(origin, 'AWS::DynamoDB::Table')).toEqual(['Retain', 'Retain']);
  origin.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'credential-vault-by-provider' });
  origin.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'credential-vault' });
  expect(retained(origin, 'AWS::KMS::Key')).toEqual(['Retain']);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::TrustStore', 1);
  origin.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
  const custom = Object.values(origin.findResources('AWS::CloudFormation::CustomResource'))
    .filter(resource => resource.Properties.Kind !== 'ParkedWorker').map(resource => `${resource.Properties.Kind} ${resource.Properties.Hostname}`);
  const hosts = [identity.domains.chatService, identity.domains.chatServicePreview].map((url: string) => new URL(url).hostname);
  expect(custom.sort()).toEqual(['Aop', 'Certificate', 'Dns'].flatMap(kind => hosts.map(host => `${kind} ${host}`)).sort());
});

test('Parked keeps both DNS records proxied at a reserved placeholder; Live points them at the ALB', () => {
  const targets = (parked: boolean) => Object.values(synthProduction(parked).origin.findResources('AWS::CloudFormation::CustomResource'))
    .filter(resource => resource.Properties.Kind === 'Dns').map(resource => resource.Properties.Target);
  expect(targets(true)).toEqual(['parked.invalid', 'parked.invalid']);
  const live = targets(false);
  expect(live).toHaveLength(2);
  for (const target of live) expect(target).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Origin/), 'DNSName'] });
});

test.each([true, false])('parked=%s turns monitoring that would breach at zero tasks off when Parked and on when Live', parked => {
  const { origin, health } = synthProduction(parked);
  const { alarmName } = identity.aws.ecs.apiHealth;
  const preview = (suffix: string) => `${identity.aws.ecs.cluster}-preview-${suffix}`;
  // Create-only properties equal the hand-made check's, so the import never replaces it (aws-alerting-stack.md).
  health.hasResourceProperties('AWS::Route53::HealthCheck', {
    HealthCheckConfig: {
      Type: 'HTTPS', FullyQualifiedDomainName: new URL(identity.domains.chatService).hostname, Port: 443, ResourcePath: '/health',
      RequestInterval: 30, FailureThreshold: 3, MeasureLatency: true, EnableSNI: true,
    },
    HealthCheckTags: [{ Key: 'Name', Value: alarmName }],
  });
  // CloudFormation's HealthCheckConfig has no Disabled property, so the stack sets it through the Route 53 API.
  const [toggle] = Object.values(health.findResources('Custom::AWS')).map(resource => resource.Properties);
  for (const call of [toggle.Create, toggle.Update]) {
    expect(call).toEqual({ 'Fn::Join': ['', [
      `{"service":"Route53","action":"updateHealthCheck","parameters":{"HealthCheckId":"`, { Ref: 'ApiHealthCheck' },
      `","Disabled":${parked}},"physicalResourceId":{"id":"ApiHealthCheckDisabled"}}`]] });
  }
  health.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: alarmName, Namespace: 'AWS/Route53', MetricName: 'HealthCheckStatus',
    Dimensions: [{ Name: 'HealthCheckId', Value: { Ref: 'ApiHealthCheck' } }],
    Statistic: 'Minimum', Period: 60, EvaluationPeriods: 2, Threshold: 1,
    ComparisonOperator: 'LessThanThreshold', TreatMissingData: 'breaching', ActionsEnabled: !parked,
  });
  const actions = Object.values(origin.findResources('AWS::CloudWatch::Alarm'))
    .map(resource => [resource.Properties.AlarmName ?? 'credential errors', resource.Properties.ActionsEnabled]).sort();
  // The ALB alarms go with the ALB while Parked; the task deficit alarm stays, silenced. The Credential
  // Service error, Agent Computer stop sleep, Session purge and Turn summary failure alarms count
  // logged lines, so they cannot breach at zero tasks and keep their actions.
  expect(actions).toEqual([['credential errors', undefined],
  [`${identity.aws.ecs.cluster}-agent-computer-stop-sleep-failures`, undefined], ...parked
    ? [[preview('task-deficit'), false]]
    : ['alb-5xx', 'target-5xx', 'task-deficit', 'unhealthy-hosts'].map(suffix => [preview(suffix), true]),
  [`${identity.aws.ecs.cluster}-session-purge-failures`, undefined],
  [`${identity.aws.ecs.cluster}-turn-summary-failures`, undefined]]);
});

test('park silences API health before the origin stops serving; unpark restores it after the origin serves again', () => {
  const parked = synthProduction(true).deployedAfter;
  expect(parked('PreviewOrigin')).toContain('ApiHealth');
  expect(parked('ApiHealth')).toEqual([]);
  const live = synthProduction(false).deployedAfter;
  expect(live('ApiHealth')).toEqual(['PreviewOrigin']);
  expect(live('PreviewOrigin')).not.toContain('ApiHealth');
});

test('Only Parked routes the parked Worker on both API hostnames, granting the Chat Service CORS origins', () => {
  const workers = (parked: boolean) => Object.values(synthProduction(parked).origin.findResources('AWS::CloudFormation::CustomResource'))
    .filter(resource => resource.Properties.Kind === 'ParkedWorker').map(resource => resource.Properties);
  expect(workers(false)).toEqual([]);
  expect(workers(true)).toEqual([{
    ServiceToken: expect.anything(), Kind: 'ParkedWorker',
    Hostnames: [identity.domains.chatService, identity.domains.chatServicePreview].map((url: string) => new URL(url).hostname),
    Origins: identity.domains.corsOrigins,
  }]);
});

/** Resources of one type with their logical IDs. */
function resources(template: Template, type: string) {
  return Object.entries(template.findResources(type)).map(([id, resource]) => ({ id, Properties: resource.Properties, DependsOn: resource.DependsOn ?? [] }));
}

test('park cuts in-flight streams: the target group drops its deregistration delay before the Chat Service scales to 0', () => {
  const delay = (parked: boolean) => {
    const { origin } = synthProduction(parked);
    const [group] = resources(origin, 'AWS::ElasticLoadBalancingV2::TargetGroup');
    const [chat] = resources(origin, 'AWS::ECS::Service').filter(service => service.Properties.ServiceName === 'chat-service-preview');
    assert(group && chat);
    const seconds = group.Properties.TargetGroupAttributes.find((attribute: { Key: string }) => attribute.Key === 'deregistration_delay.timeout_seconds').Value;
    return { group: group.id, seconds, chatWaitsForGroup: chat.DependsOn.includes(group.id) };
  };
  // The same logical ID in both states, so park updates the group in place instead of deleting it after the service.
  expect(delay(true)).toEqual({ group: 'OriginHttpsChatServiceGroup7CF46779', seconds: '0', chatWaitsForGroup: true });
  expect(delay(false)).toEqual({ group: 'OriginHttpsChatServiceGroup7CF46779', seconds: '3600', chatWaitsForGroup: true });
});

test('unpark creates the NAT Gateway and default route before the services start', () => {
  expect(synthProduction(false).deployedAfter('PreviewOrigin')).toContain('PrivateEgress');
});

test('park removes the NAT Gateway only after the services have parked', () => {
  const { deployedAfter } = synthProduction(true);
  expect(deployedAfter('PrivateEgress')).toContain('PreviewOrigin');
  expect(deployedAfter('PreviewOrigin')).not.toContain('PrivateEgress');
});

test('each stack deploys under its configured name to the production account', () => {
  const { app } = synthProduction(false);
  const stacks = ['ChatStorage', 'PrivateEgress', 'ApiHealth', 'PreviewOrigin'].map(id => app.node.findChild(id) as Stack);
  expect(stacks.map(stack => [stack.stackName, stack.account, stack.region])).toEqual([
    ['ChatStorage', identity.aws.account, identity.aws.region],
    [identity.aws.ecs.privateEgress.stackName, identity.aws.account, identity.aws.region],
    [identity.aws.ecs.apiHealth.stackName, identity.aws.account, identity.aws.region],
    [identity.aws.ecs.previewOriginStackName, identity.aws.account, identity.aws.region],
  ]);
});

test('API health checks the production API, alarms to the alert topic, and outputs the check and alarm', () => {
  const { health } = synthProduction(false);
  const hostname = new URL(identity.domains.chatService).hostname;
  const topic = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:sns:${identity.aws.region}:${identity.aws.account}:${identity.aws.ecs.alertsTopicName}`]] };
  const [alarmEntry] = Object.entries(health.findResources('AWS::CloudWatch::Alarm'));
  assert(alarmEntry);
  const [alarmId, alarm] = alarmEntry;
  expect(alarm).toMatchObject({ DeletionPolicy: 'Delete', Properties: { AlarmDescription: `${hostname}/health failing from Route 53 checkers`, AlarmActions: [topic], OKActions: [topic] } });
  const [check] = Object.values(health.findResources('AWS::Route53::HealthCheck'));
  assert(check);
  expect(check.DeletionPolicy).toBe('Delete');
  const [toggle] = Object.values(health.findResources('Custom::AWS')).map(resource => resource.Properties);
  expect(toggle.InstallLatestAwsSdk).toBe(false);
  const [policy] = Object.values(health.findResources('AWS::IAM::Policy')).map(resource => resource.Properties.PolicyDocument.Statement);
  expect(policy).toEqual([{ Action: 'route53:UpdateHealthCheck', Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:aws:route53:::healthcheck/', { Ref: 'ApiHealthCheck' }]] } }]);
  expect(health.toJSON().Outputs).toEqual({ HealthCheckId: { Value: { Ref: 'ApiHealthCheck' } }, AlarmName: { Value: { Ref: alarmId } } });
});

test('the Chat Service reaches the credential service and drives the private NAT browser with its extension', () => {
  const { origin } = synthProduction(false);
  const keys = identity.aws.ecs.credentialService.environmentKeys;
  const browser = identity.aws.agentCore.privateNatBrowser;
  const [chatEntry] = Object.entries(origin.findResources('AWS::ECS::TaskDefinition')).filter(([id]) => id.startsWith('ChatServiceTask5'));
  assert(chatEntry);
  const [, chat] = chatEntry;
  const [container] = chat.Properties.ContainerDefinitions;
  const secret = Object.keys(origin.findResources('AWS::SecretsManager::Secret')).find(id => id.includes('CredentialServiceInvocationSecret'));
  const turnMemorySecret = Object.keys(origin.findResources('AWS::SecretsManager::Secret')).find(id => id.includes('TurnMemorySecret'));
  expect(container.Environment.slice(-4)).toEqual([
    { Name: keys.url, Value: `http://credentials.${identity.aws.ecs.privateNamespace}:${identity.aws.credentialService.port}${identity.aws.ecs.credentialService.rpcPath}` },
    { Name: 'AGENTCORE_BROWSER_EXTENSION_S3_BUCKET', Value: browser.extension.bucket },
    { Name: 'AGENTCORE_BROWSER_EXTENSION_S3_PREFIX', Value: browser.extension.prefix },
    { Name: 'AGENTCORE_BROWSER_EXTENSION_S3_VERSION_ID', Value: browser.extension.versionId },
  ]);
  expect(container.Environment).toContainEqual({ Name: 'AGENTCORE_BROWSER_ID', Value: browser.id });
  expect(container.Secrets).toEqual([{ Name: 'BOTCUBE_TURN_MEMORY_SECRET', ValueFrom: { Ref: turnMemorySecret } }, { Name: keys.invocationToken, ValueFrom: { Ref: secret } }]);
  const [policyEntry] = Object.entries(origin.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('ChatServiceTaskTaskRoleDefaultPolicy'));
  assert(policyEntry);
  const [, policy] = policyEntry;
  const [agentComputer] = Object.keys(origin.findResources('AWS::BedrockAgentCore::BrowserCustom'));
  assert(agentComputer);
  const agentComputerArn = { 'Fn::GetAtt': [agentComputer, 'BrowserArn'] };
  expect(policy.Properties.PolicyDocument.Statement.slice(-5)).toEqual([
    { Action: ['bedrock-agentcore:GetBrowser', 'bedrock-agentcore:StartBrowserSession',
      'bedrock-agentcore:ListBrowserSessions', 'bedrock-agentcore:GetBrowserSession',
      'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:UpdateBrowserStream',
      'bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:ConnectBrowserLiveViewStream'], Effect: 'Allow',
    Resource: [
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:browser-custom/${browser.id}`]] },
      agentComputerArn,
    ] },
    { Action: 'bedrock-agentcore:CreateBrowserProfile', Effect: 'Allow',
      Resource: '*' },
    { Action: ['bedrock-agentcore:SaveBrowserSessionProfile', 'bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:DeleteBrowserProfile'], Effect: 'Allow',
      Resource: [
        { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:browser-profile/${identity.aws.agentCore.agentComputerBrowser.profileNamePrefix}*`]] },
        agentComputerArn,
      ] },
    { Action: ['s3:GetObject', 's3:GetObjectVersion'], Effect: 'Allow', Resource: `arn:aws:s3:::${browser.extension.bucket}/${browser.extension.prefix}` },
    { Action: 'bedrock:InvokeModel', Effect: 'Allow', Resource: [
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock:${identity.aws.region}:${identity.aws.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`]] },
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
    ] },
  ]);
});

test("Agent Computer browsers mount each account's Files, and the Chat Service hands them out", () => {
  const { origin, storage } = synthProduction(false);
  const browser = identity.aws.agentCore.privateNatBrowser;
  const [browsers] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/AgentComputerBrowsers' } }));
  assert(browsers);
  const [fileSystem] = Object.keys(storage.findResources('AWS::S3Files::FileSystem'));
  const [bucket] = Object.keys(storage.findResources('AWS::S3::Bucket'));
  assert(fileSystem && bucket);
  const imported = (logicalId: string) => ({ 'Fn::ImportValue': expect.stringContaining(logicalId) });
  const [group] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/FilesMountTargets' } }));
  assert(group);
  origin.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'PreviewOrigin/FilesMountTargets', SecurityGroupIngress: Match.absent(),
    SecurityGroupEgress: [Match.objectLike({ Description: 'Disallow all traffic' })],
  });
  const ingress = Object.values(origin.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => rule.Properties)
    .filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify({ 'Fn::GetAtt': [group, 'GroupId'] }));
  expect(ingress).toEqual([{
    GroupId: { 'Fn::GetAtt': [group, 'GroupId'] }, SourceSecurityGroupId: { 'Fn::GetAtt': [browsers, 'GroupId'] },
    IpProtocol: 'tcp', FromPort: 2049, ToPort: 2049, Description: 'Agent Computer browsers mount Files',
  }]);
  expect(Object.values(origin.findResources('AWS::S3Files::MountTarget')).map(target => target.Properties)).toEqual(
    browser.subnets.map((subnet: { id: string }) => ({
      FileSystemId: imported(fileSystem), SubnetId: subnet.id, SecurityGroups: [{ 'Fn::GetAtt': [group, 'GroupId'] }],
    })),
  );
  const [chatEntry] = Object.entries(origin.findResources('AWS::ECS::TaskDefinition')).filter(([id]) => id.startsWith('ChatServiceTask5'));
  assert(chatEntry);
  const environment = Object.fromEntries(chatEntry[1].Properties.ContainerDefinitions[0].Environment.map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]));
  expect(environment).toMatchObject({
    [chatKeys.filesBucket]: imported(bucket),
    [chatKeys.filesFileSystemArn]: imported(fileSystem),
    [chatKeys.agentComputerPolicyBucket]: expect.anything(),
    [chatKeys.agentComputerPolicyKey]: expect.stringMatching(/\.json$/),
  });
  const [policyEntry] = Object.entries(origin.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('ChatServiceTaskTaskRoleDefaultPolicy'));
  assert(policyEntry);
  const statements = policyEntry[1].Properties.PolicyDocument.Statement;
  expect(statements).toEqual(expect.arrayContaining([
    expect.objectContaining({ Action: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'], Resource: expect.arrayContaining([expect.objectContaining({ 'Fn::Join': ['', expect.arrayContaining([expect.stringContaining(':s3:::cdk-')])] })]) }),
    expect.objectContaining({ Action: ['s3files:CreateAccessPoint', 's3files:GetAccessPoint', 's3files:DeleteAccessPoint'], Resource: [imported(fileSystem), expect.anything()] }),
    expect.objectContaining({ Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': 'accounts/*' } } }),
    expect.objectContaining({ Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'], Resource: expect.objectContaining({ 'Fn::Join': ['', [expect.anything(), '/accounts/*']] }) }),
  ]));
});

test("the agent's Files sync through a role the Chat Service narrows to one account, and Account Claim moves them", () => {
  const { origin, storage } = synthProduction(false);
  const [bucket] = Object.keys(storage.findResources('AWS::S3::Bucket'));
  assert(bucket);
  const [syncRoleEntry] = Object.entries(origin.findResources('AWS::IAM::Role')).filter(([id]) => id.startsWith('FilesSyncRole'));
  assert(syncRoleEntry);
  const [syncRole, { Properties: role }] = syncRoleEntry;
  const [chatEntry] = Object.entries(origin.findResources('AWS::ECS::TaskDefinition')).filter(([id]) => id.startsWith('ChatServiceTask5'));
  assert(chatEntry);
  const environment = Object.fromEntries(chatEntry[1].Properties.ContainerDefinitions[0].Environment.map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]));
  expect(environment[chatKeys.filesSyncRoleArn]).toEqual({ 'Fn::GetAtt': [syncRole, 'Arn'] });
  // Only the Chat Service assumes it, for an hour at most: role chaining's ceiling.
  expect(role.AssumeRolePolicyDocument.Statement).toEqual([
    { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { AWS: { 'Fn::GetAtt': [chatEntry[1].Properties.TaskRoleArn['Fn::GetAtt'][0], 'Arn'] } } },
  ]);
  expect(role.MaxSessionDuration).toBe(3600);
  const syncPolicies = Object.values(origin.findResources('AWS::IAM::Policy')).filter((policy) => JSON.stringify(policy.Properties.Roles) === JSON.stringify([{ Ref: syncRole }]));
  expect(syncPolicies.flatMap((policy) => policy.Properties.PolicyDocument.Statement)).toEqual([
    { Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': 'accounts/*' } }, Effect: 'Allow', Resource: { 'Fn::ImportValue': expect.stringContaining(bucket) } },
    { Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: { 'Fn::Join': ['', [{ 'Fn::ImportValue': expect.stringContaining(bucket) }, '/accounts/*']] } },
  ]);
  const [policyEntry] = Object.entries(origin.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('ChatServiceTaskTaskRoleDefaultPolicy'));
  assert(policyEntry);
  expect(policyEntry[1].Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining([
    expect.objectContaining({ Action: 's3:DeleteObject', Resource: expect.objectContaining({ 'Fn::Join': ['', [expect.anything(), '/accounts/*']] }) }),
    expect.objectContaining({ Action: 's3:ListBucketVersions', Condition: { StringLike: { 's3:prefix': 'accounts/*' } } }),
    expect.objectContaining({ Action: 's3:DeleteObjectVersion', Resource: expect.objectContaining({ 'Fn::Join': ['', [expect.anything(), '/accounts/*']] }) }),
  ]));
});

test('the Agent Computer runs in its own browser, whose execution role alone mounts Files, in the login browser subnets (ADR 0077)', () => {
  const { app, origin, storage } = synthProduction(false);
  const [fileSystem] = Object.keys(storage.findResources('AWS::S3Files::FileSystem'));
  const [network] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/AgentComputerBrowsers' } }));
  const [browserEntry] = Object.entries(origin.findResources('AWS::BedrockAgentCore::BrowserCustom'));
  // Chromium's own sign-in and promotions are off in every session: those policies apply only as managed ones.
  const managedPolicy = app.node.findAll().find((node): node is AssetStaging => node instanceof AssetStaging
    && node.sourcePath === path.join(deployRoot, 'agent-computer', 'chrome-managed-policy.json'));
  assert(fileSystem && network && browserEntry && managedPolicy);
  const [browserId, browser] = browserEntry;
  const [role] = Object.keys(origin.findResources('AWS::IAM::Role', { Properties: { AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'bedrock-agentcore.amazonaws.com' } })] } } }));
  assert(role);
  expect(browser.Properties).toEqual({
    Name: identity.aws.agentCore.agentComputerBrowser.name,
    ExecutionRoleArn: { 'Fn::GetAtt': [role, 'Arn'] },
    NetworkConfiguration: { NetworkMode: 'VPC', VpcConfig: {
      Subnets: identity.aws.agentCore.privateNatBrowser.subnets.map((subnet: { id: string }) => subnet.id),
      SecurityGroups: [{ 'Fn::GetAtt': [network, 'GroupId'] }],
    } },
    EnterprisePolicies: [{ Type: 'MANAGED', Location: { Bucket: expect.anything(), Prefix: `${managedPolicy.assetHash}.json` } }],
  });
  origin.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Condition: { StringEquals: { 'aws:SourceAccount': identity.aws.account } } }] },
  });
  const fileSystemArn = { 'Fn::ImportValue': expect.stringContaining(fileSystem) };
  const statements = (roleRef: string) => Object.values(origin.findResources('AWS::IAM::Policy'))
    .filter(policy => JSON.stringify(policy.Properties.Roles).includes(roleRef)).flatMap(policy => policy.Properties.PolicyDocument.Statement);
  expect(statements(role)).toEqual([{
    Action: ['s3files:ClientMount', 's3files:ClientWrite', 's3files:GetAccessPoint'], Effect: 'Allow', Resource: fileSystemArn,
    Condition: { ArnLike: { 's3files:AccessPointArn': { 'Fn::Join': ['', [fileSystemArn, '/access-point/*']] } } },
  }]);
  // The browser assumes its role when a session starts, so the role's policy exists before the browser.
  const [rolePolicy] = Object.keys(origin.findResources('AWS::IAM::Policy', { Properties: { Roles: [{ Ref: role }] } }));
  expect(browser.DependsOn).toEqual(expect.arrayContaining([rolePolicy]));
  // Only the browser's own role may mount Files; the Chat Service hands out access points but never mounts them.
  const mounters = Object.values(origin.findResources('AWS::IAM::Policy'))
    .filter(policy => JSON.stringify(policy.Properties.PolicyDocument).includes('s3files:ClientMount')).map(policy => policy.Properties.Roles);
  expect(mounters).toEqual([[{ Ref: role }]]);
  const environment = (prefix: string) => {
    const [entry] = Object.entries(origin.findResources('AWS::ECS::TaskDefinition')).filter(([id]) => id.startsWith(prefix));
    assert(entry);
    return entry[1].Properties.ContainerDefinitions[0].Environment;
  };
  const agentComputerBrowser = { Name: 'AGENTCORE_AGENT_COMPUTER_BROWSER_ID', Value: { 'Fn::GetAtt': [browserId, 'BrowserId'] } };
  const loginBrowser = { Name: 'AGENTCORE_BROWSER_ID', Value: identity.aws.agentCore.privateNatBrowser.id };
  for (const service of ['ChatServiceTask5', 'CredentialServiceTask']) {
    expect(environment(service)).toEqual(expect.arrayContaining([agentComputerBrowser, loginBrowser]));
  }
  // The reaper stops only abandoned link sessions, which run in the login browser.
  expect(environment('ChatServiceReaperTask')).toContainEqual(loginBrowser);
});

test('the AgentCore runtime network is published for the AgentCore stack and admitted to the credential service', () => {
  const { origin } = synthProduction(false);
  const [agent] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/AgentNetwork' } }));
  const [chat] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/ChatService/Ingress' } }));
  const [credential] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/CredentialService/Network' } }));
  assert(agent && chat && credential);
  const groupId = (id: string) => ({ 'Fn::GetAtt': [id, 'GroupId'] });
  origin.hasResourceProperties('AWS::SSM::Parameter', { Name: identity.aws.agentCore.runtimeNetworkParameter, Value: groupId(agent) });
  expect(origin.toJSON().Outputs.AgentSecurityGroupId).toEqual({ Value: groupId(agent) });
  const callers = Object.values(origin.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => rule.Properties)
    .filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(groupId(credential))).map(rule => [rule.SourceSecurityGroupId, rule.FromPort]);
  expect(callers).toEqual([[groupId(chat), identity.aws.credentialService.port], [groupId(agent), identity.aws.credentialService.port]]);
});

test("the agent reaches the Chat Service's Agent Computer CDP filter on its port alone, at the task's own address (ADR 0075)", () => {
  const { origin } = synthProduction(false);
  const [agent] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/AgentNetwork' } }));
  const [chat] = Object.keys(origin.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'PreviewOrigin/ChatService/Ingress' } }));
  assert(agent && chat);
  const groupId = (id: string) => ({ 'Fn::GetAtt': [id, 'GroupId'] });
  const fromAgent = Object.values(origin.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => rule.Properties)
    .filter(rule => JSON.stringify(rule.SourceSecurityGroupId) === JSON.stringify(groupId(agent)) && JSON.stringify(rule.GroupId) === JSON.stringify(groupId(chat)))
    .map(rule => [rule.IpProtocol, rule.FromPort, rule.ToPort]);
  expect(fromAgent).toEqual([['tcp', 8123, 8123]]);
  const [chatEntry] = Object.entries(origin.findResources('AWS::ECS::TaskDefinition')).filter(([id]) => id.startsWith('ChatServiceTask5'));
  assert(chatEntry);
  expect(chatEntry[1].Properties.ContainerDefinitions[0].Environment).toContainEqual({
    Name: chatKeys.agentComputerCdpUrl, Value: 'ws://task-address:8123/agent-computer/cdp',
  });
});

test('park routes the parked Worker before DNS leaves the ALB', () => {
  const { origin } = synthProduction(true);
  const dns = resources(origin, 'AWS::CloudFormation::CustomResource').filter(resource => resource.Properties.Kind === 'Dns');
  expect(dns.map(record => record.DependsOn)).toEqual([expect.arrayContaining(['ParkedWorker']), expect.arrayContaining(['ParkedWorker'])]);
});

test('the origin provider Lambdas bundle the Cartridge origin-provider directory', () => {
  const { app } = synthProduction(false);
  const sources = app.node.findAll().filter((node): node is AssetStaging => node instanceof AssetStaging)
    .filter(staging => staging.node.path.startsWith('PreviewOrigin/')).map(staging => staging.sourcePath);
  expect(sources).toContain(path.join(deployRoot, 'ecs', 'origin-provider'));
});

test('web latency reports from the web and its Dev environment as guests that may only put RUM events, as one Latency metric per moment', () => {
  const { app } = synthProduction(false);
  const stack = app.node.findChild('WebLatency') as Stack;
  expect([stack.stackName, stack.account, stack.region]).toEqual([identity.aws.ecs.webLatency.stackName, identity.aws.account, identity.aws.region]);
  const latency = Template.fromStack(stack);
  latency.hasResourceProperties('AWS::RUM::AppMonitor', {
    Name: identity.aws.ecs.webLatency.appMonitorName,
    DomainList: identity.domains.corsOrigins.filter((origin: string) => origin.startsWith('https://')).map((origin: string) => new URL(origin).hostname),
    CustomEvents: { Status: 'ENABLED' },
    AppMonitorConfiguration: Match.objectLike({
      IdentityPoolId: { Ref: 'Guests' },
      SessionSampleRate: 1,
      MetricDestinations: [{
        Destination: 'CloudWatch',
        // RUM accepts a dimension only when its pattern names the field, and a pattern array only with one value.
        MetricDefinitions: Object.keys(budgets.moments).map(moment => ({
          Name: 'Latency', Namespace: 'WebLatency', UnitLabel: 'Milliseconds', ValueKey: 'event_details.durationMs',
          DimensionKeys: { 'event_details.moment': 'Moment' }, EventPattern: `{"event_type":["latency"],"event_details":{"moment":["${moment}"]}}`,
        })),
      }],
    }),
  });
  latency.hasResourceProperties('AWS::Cognito::IdentityPool', { AllowUnauthenticatedIdentities: true });
  const policies = Object.values(latency.findResources('AWS::IAM::Policy'));
  const statementsOf = (role: string) => policies.find(resource => resource.Properties.Roles[0].Ref.startsWith(role))?.Properties.PolicyDocument.Statement;
  expect(statementsOf('Guest')).toEqual([{
    Action: 'rum:PutRumEvents', Effect: 'Allow',
    Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:rum:${identity.aws.region}:${identity.aws.account}:appmonitor/${identity.aws.ecs.webLatency.appMonitorName}`]] },
  }]);
  // The daily Latency budgets workflow reads the metrics from main, and may do nothing else.
  expect(statementsOf('Reader')).toEqual([{ Action: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics'], Effect: 'Allow', Resource: '*' }]);
  latency.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({
        Condition: { StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `${identity.github.oidcSubjectPrefix}:ref:refs/heads/main`,
        } },
      })],
    }),
  });
  expect(latency.findResources('AWS::CloudWatch::Alarm')).toEqual({});
});


test('production resource overrides reach every consumer and boundary covers only owned stacks', () => {
  const app = new App();
  const external = new Stack(app, 'External', { env: { account: identity.aws.account, region: identity.aws.region } });
  new iam.Role(external, 'UnrelatedRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  const vpc = ec2.Vpc.fromVpcAttributes(external, 'Vpc', { vpcId: 'vpc-corporate', availabilityZones: ['us-east-1a', 'us-east-1b'], privateSubnetIds: ['subnet-corp-a', 'subnet-corp-b'], publicSubnetIds: ['subnet-public-a', 'subnet-public-b'] });
  const roleArn = `arn:aws:iam::${identity.aws.account}:role/corporate-ecs`;
  const keyArn = `arn:aws:kms:${identity.aws.region}:${identity.aws.account}:key/corporate-key`;
  const boundaryArn = `arn:aws:iam::${identity.aws.account}:policy/corporate-boundary`;
  defineProduction(app, {
    repositoryRoot, deployRoot, identity, parked: false,
    executionRole: iam.Role.fromRoleArn(external, 'ExecutionRole', roleArn, { mutable: false }),
    kmsKey: kms.Key.fromKeyArn(external, 'Key', keyArn),
    permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(external, 'Boundary', boundaryArn),
    vpc, publicSubnets: { subnetType: ec2.SubnetType.PUBLIC }, privateSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    chatTableName: 'corporate-chat',
    origin: { input: { cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', memoryId: 'test_memory-AbCdEfGhIj', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/test-runtime` }, images: { chat: ContainerImage.fromRegistry('chat-image'), credential: ContainerImage.fromRegistry('credential-image') }, commit: 'abc123' },
  });
  const origin = Template.fromStack(app.node.findChild('PreviewOrigin') as Stack);
  origin.resourceCountIs('AWS::KMS::Key', 0);
  for (const task of Object.values(origin.findResources('AWS::ECS::TaskDefinition'))) expect(task.Properties.ExecutionRoleArn).toBe(roleArn);
  origin.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { NetworkConfiguration: { NetworkMode: 'VPC', VpcConfig: Match.objectLike({ Subnets: ['subnet-corp-a', 'subnet-corp-b'] }) } });
  origin.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Subnets: ['subnet-public-a', 'subnet-public-b'] });
  for (const id of ['ChatStorage', 'ApiHealth', 'WebLatency', 'PreviewOrigin']) {
    const template = Template.fromStack(app.node.findChild(id) as Stack);
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) expect(role.Properties.PermissionsBoundary).toBe(boundaryArn);
  }
  Template.fromStack(app.node.findChild('ChatStorage') as Stack).hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'corporate-chat' });
  Template.fromStack(external).hasResourceProperties('AWS::IAM::Role', { PermissionsBoundary: Match.absent() });
});

test.each([[true, false], [true, true], [false, true]])('production network agrees with supplied VPC %s and explicit selection %s', (suppliedVpc, explicit) => {
  const app = new App();
  const external = new Stack(app, 'External', { env: { account: identity.aws.account, region: identity.aws.region } });
  const privateIds = suppliedVpc ? ['subnet-corp-a', 'subnet-corp-b'] : identity.aws.agentCore.privateNatBrowser.subnets.map((subnet: { id: string }) => subnet.id);
  const vpcId = suppliedVpc ? 'vpc-corporate' : identity.aws.credentialService.vpcId;
  const vpc = ec2.Vpc.fromVpcAttributes(external, 'Vpc', {
    vpcId, availabilityZones: ['us-east-1a', 'us-east-1b'],
    privateSubnetIds: privateIds, publicSubnetIds: ['subnet-public-a', 'subnet-public-b'],
  });
  const selectedSubnet = vpc.privateSubnets[1];
  assert(selectedSubnet);
  const subnetIds = explicit ? [privateIds[1]] : privateIds;
  defineProduction(app, {
    repositoryRoot, deployRoot, identity, parked: false, ...(suppliedVpc ? { vpc } : {}),
    ...(explicit ? { privateSubnets: { subnets: [selectedSubnet] } } : {}),
    chat: { port: 9443 },
    origin: { input: { cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', memoryId: 'test_memory-AbCdEfGhIj', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/test-runtime` }, images: { chat: ContainerImage.fromRegistry('chat-image'), credential: ContainerImage.fromRegistry('credential-image') }, commit: 'abc123' },
  });
  const template = Template.fromStack(app.node.findChild('PreviewOrigin') as Stack);
  template.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { NetworkConfiguration: { VpcConfig: { Subnets: subnetIds, SecurityGroups: Match.anyValue() }, NetworkMode: 'VPC' } });
  expect(Object.values(template.findResources('AWS::S3Files::MountTarget')).map(resource => resource.Properties.SubnetId)).toEqual(subnetIds);
  for (const service of Object.values(template.findResources('AWS::ECS::Service'))) expect(service.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets).toEqual(subnetIds);
  template.hasResourceProperties('AWS::Events::Rule', { Targets: Match.arrayWith([Match.objectLike({ EcsParameters: { NetworkConfiguration: { AwsVpcConfiguration: { AssignPublicIp: 'DISABLED', Subnets: subnetIds, SecurityGroups: Match.anyValue() } }, LaunchType: 'FARGATE', TaskCount: 1, TaskDefinitionArn: Match.anyValue() } })]) });
  for (const group of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) expect(group.Properties.VpcId).toBe(vpcId);
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: 9443, ToPort: 9443, Description: 'Harness Agent Computer CDP' });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: Match.arrayWith([Match.objectLike({ PortMappings: [{ ContainerPort: 9443, Protocol: 'tcp' }], Environment: Match.arrayWith([{ Name: chatKeys.agentComputerCdpUrl, Value: 'ws://task-address:9443/agent-computer/cdp' }]) })]) });
});

test.each([false, true])('production rejects an empty explicit private subnet selection with supplied VPC %s', suppliedVpc => {
  const app = new App();
  const external = new Stack(app, 'External', { env: { account: identity.aws.account, region: identity.aws.region } });
  const vpc = ec2.Vpc.fromVpcAttributes(external, 'Vpc', { vpcId: 'vpc-corporate', availabilityZones: ['us-east-1a', 'us-east-1b'], privateSubnetIds: ['subnet-corp-a', 'subnet-corp-b'], publicSubnetIds: ['subnet-public-a', 'subnet-public-b'] });
  expect(() => defineProduction(app, {
    repositoryRoot, deployRoot, identity, parked: false, ...(suppliedVpc ? { vpc } : {}), privateSubnets: { subnets: [] },
    origin: { input: { cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', memoryId: 'test_memory-AbCdEfGhIj', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/test-runtime` }, images: { chat: ContainerImage.fromRegistry('chat-image'), credential: ContainerImage.fromRegistry('credential-image') }, commit: 'abc123' },
  })).toThrow('requires a non-empty private subnet selection');
});

test('production binds its login browser through deployment identity rather than chat overrides', () => {
  const acceptsChatBrowserOverride: 'browserId' extends keyof NonNullable<ProductionOptions['chat']> ? true : false = false;
  expect(acceptsChatBrowserOverride).toBe(false);
});
