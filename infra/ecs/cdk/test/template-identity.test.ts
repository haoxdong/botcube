import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { cartridgeIdentity } from '../lib/cartridge.js';
import { defineProduction } from '../lib/production.js';

const identity = cartridgeIdentity(path.resolve(__dirname, '../../../../templates/always-on/deploy'));
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
  const caPath = path.join(root, identity.aws.ecs.originPullCaCertificate);
  fs.mkdirSync(path.dirname(caPath), { recursive: true });
  fs.writeFileSync(caPath, 'local synthesis fixture');
  const app = new App();
  return { root, deployRoot, app };
}

test.each([true, false])('synthesizes the template identity with parked=%s and local fixture assets', parked => {
  const { root, deployRoot, app } = fixture();
  const webLatency = { sessionSampleRate: 1, moments: ['first-response'] };
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, parked, webLatency,
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: ContainerImage.fromRegistry('template-credentials') },
      commit: 'local-fixture',
    },
  });
  Template.fromStack(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: { MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [{ EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'], automated: [false] } }) }] }] },
  });
  const origin = Template.fromStack(app.node.findChild('PreviewOrigin') as Stack);
  origin.resourceCountIs('AWS::ECS::Service', 2);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', parked ? 0 : 1);
  Template.fromStack(app.node.findChild('PrivateEgress') as Stack).resourceCountIs('AWS::EC2::NatGateway', parked ? 0 : 1);
  expect((app.node.findChild('PreviewOrigin') as Stack).stackName).toBe(identity.aws.ecs.previewOriginStackName);
  origin.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { Name: identity.aws.agentCore.agentComputerBrowser.name });
  origin.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
    { Name: 'BOTCUBE_PARK_STATE_PARAMETER', Value: identity.ssm.parkState }, { Name: 'BOTCUBE_PRODUCT_NAME', Value: 'BotCube' },
  ]) })]) });
  const parkReads = Object.values(origin.findResources('AWS::IAM::Policy'))
    .flatMap(({ Properties }) => (Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]))
    .filter(({ Action }) => Action === 'ssm:GetParameterHistory');
  expect(parkReads.map(({ Resource }) => JSON.stringify(Resource))).toEqual([expect.stringContaining(`:parameter${identity.ssm.parkState}"`)]);
});
test.each([true, false])('parks idle production and wakes it from the paused page with parked=%s', parked => {
  const { root, deployRoot, app } = fixture();
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, parked, webLatency: { sessionSampleRate: 1, moments: ['first-response'] },
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: ContainerImage.fromRegistry('template-credentials') },
      commit: 'local-fixture',
    },
  });
  const parking = Template.fromStack(app.node.findChild('ProductionParking') as Stack);
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
  // Only the dispatcher may read the App key; the internet-facing wake function never can.
  expect(rolesAllowed('secretsmanager:GetSecretValue')).toEqual(['dispatcherServiceRole']);
  expect(rolesAllowed('dynamodb:PutItem')).toEqual(['wakeServiceRole']);
  for (const { Properties } of policies) {
    for (const statement of Properties.PolicyDocument.Statement.filter(({ Action }) => [Action].flat().some(action => /^dynamodb:(Get|Put|Update|Delete)Item$|^dynamodb:Query$/.test(action)))) {
      expect(statement.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PRODUCTION_PARKING'] } });
    }
  }
  Template.fromStack(app.node.findChild('ChatStorage') as Stack).hasResourceProperties('AWS::DynamoDB::Table', { StreamSpecification: { StreamViewType: 'NEW_IMAGE' } });
  expect(Object.values(parking.toJSON().Outputs as Record<string, { Export?: { Name: string } }>).map(({ Export }) => Export?.Name))
    .toContain('ProductionParking:ExportsOutputFnGetAttwakeFunctionUrlA2A050A1FunctionUrl3B1B4F3E');
  const origin = Template.fromStack(app.node.findChild('PreviewOrigin') as Stack);
  if (parked) origin.hasResourceProperties('AWS::CloudFormation::CustomResource', { Kind: 'ParkedWorker', WakeUrl: Match.anyValue(), Script: Match.stringLikeRegexp('^[0-9a-f]{64}$') });
  origin.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([{ Name: 'BOTCUBE_REPORT_ACTIVITY', Value: 'true' }]) })]) });
});
test.each([true, false])('composition names adopter-owned networks and browser role with parked=%s', parked => {
  const { root, deployRoot, app } = fixture();
  const webLatency = { sessionSampleRate: 1, moments: ['first-response'] };
  defineProduction(app, {
    repositoryRoot: root, deployRoot, identity, parked, webLatency,
    storage: { tableName: 'adopter-chat', filesBucketName: 'adopter-files', filesSyncRoleName: 'adopter-files-service' },
    originConfig: {
      securityGroupName: 'adopter-origin-ingress',
      agentNetworkSecurityGroupName: 'adopter-agent-network',
      agentComputerSecurityGroupName: 'adopter-browser-network',
      filesMountTargetsSecurityGroupName: 'adopter-files-network',
      agentComputerBrowserRoleName: 'adopter-browser-role',
      filesSyncRoleName: 'adopter-chat-files-sync',
    },
    origin: {
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: ContainerImage.fromRegistry('template-credentials') },
      commit: 'local-fixture',
    },
  });
  Template.fromStack(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: { MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [{ EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'], automated: [false] } }) }] }] },
  });
  const origin = Template.fromStack(app.node.findChild('PreviewOrigin') as Stack);
  const storage = Template.fromStack(app.node.findChild('ChatStorage') as Stack);
  storage.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'adopter-chat' });
  storage.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'adopter-files' });
  storage.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-files-service' });
  for (const name of ['adopter-origin-ingress', 'adopter-agent-network', 'adopter-browser-network', 'adopter-files-network']) {
    origin.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: name });
  }
  origin.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-browser-role' });
  origin.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-chat-files-sync' });
  origin.resourceCountIs('AWS::ECS::Service', 2);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', parked ? 0 : 1);
  Template.fromStack(app.node.findChild('PrivateEgress') as Stack).resourceCountIs('AWS::EC2::NatGateway', parked ? 0 : 1);
  expect((app.node.findChild('PreviewOrigin') as Stack).stackName).toBe(identity.aws.ecs.previewOriginStackName);
  origin.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { Name: identity.aws.agentCore.agentComputerBrowser.name });
});

test('composition rejects competing chat table names before creating resources', () => {
  expect(() => defineProduction(new App(), {
    repositoryRoot: '/unused', deployRoot: '/unused', identity, parked: true,
    chatTableName: 'legacy-chat', storage: { tableName: 'configured-chat' },
  })).toThrow('Choose chatTableName or storage.tableName, not both');
});
