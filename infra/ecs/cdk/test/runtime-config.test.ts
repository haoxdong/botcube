import type { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readConfig } from '../../../../config/read.cjs';
import { botcubeConfigPath, synthesizeExample } from './example-fixture.js';

const AGENTCORE_STACK = 'AgentCore-bot-cube-template';

test.each(['public', 'enterprise'])('the %s example runs its named Bot Image without a build', async example => {
  const agentCore = Template.fromStack((await synthesizeExample(example)).node.findChild(AGENTCORE_STACK) as Stack);
  const [runtime] = Object.values(agentCore.findResources('AWS::BedrockAgentCore::Runtime'));
  expect(runtime.Properties.AgentRuntimeArtifact.ContainerConfiguration.ContainerUri)
    .toBe(readConfig(botcubeConfigPath(example)).agentCore?.runtime?.containerUri);
  const [publisher] = Object.keys(agentCore.findResources('Custom::CDKBucketDeployment'));
  expect(runtime.DependsOn).toContain(publisher);
  expect(runtime.Properties.EnvironmentVariables.BOTCUBE_CONFIG).toMatch(/^s3:\/\/botcube-config-.*\/resolved\/[a-f0-9]{64}\.json$/);
  agentCore.resourceCountIs('AWS::CodeBuild::Project', 0);
});
