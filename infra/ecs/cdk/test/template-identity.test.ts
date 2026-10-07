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

test.each([true, false])('synthesizes the template identity with parked=%s and local fixture assets', parked => {
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
