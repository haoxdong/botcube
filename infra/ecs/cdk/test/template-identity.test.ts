import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { defineProduction } from '../lib/production.js';

const identity = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../template/deploy/identity.json'), 'utf8'));
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
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', memoryId: 'template_memory-fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: ContainerImage.fromRegistry('template-credentials') },
      commit: 'local-fixture',
    },
  });
  Template.fromStack(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: { MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [{ EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'] } }) }] }] },
  });
  const origin = Template.fromStack(app.node.findChild('PreviewOrigin') as Stack);
  origin.resourceCountIs('AWS::ECS::Service', 2);
  origin.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', parked ? 0 : 1);
  Template.fromStack(app.node.findChild('PrivateEgress') as Stack).resourceCountIs('AWS::EC2::NatGateway', parked ? 0 : 1);
  expect((app.node.findChild('PreviewOrigin') as Stack).stackName).toBe(identity.aws.ecs.previewOriginStackName);
  origin.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', { Name: identity.aws.agentCore.agentComputerBrowser.name });
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
      input: { cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', memoryId: 'template_memory-fixture', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/template-fixture` },
      images: { chat: ContainerImage.fromRegistry('template-chat'), credential: ContainerImage.fromRegistry('template-credentials') },
      commit: 'local-fixture',
    },
  });
  Template.fromStack(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: { MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [{ EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'] } }) }] }] },
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
