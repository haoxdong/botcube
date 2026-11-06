import { App, Stack } from 'aws-cdk-lib';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { applyRuntimeNetwork } from '../lib/runtime-network';

test('runtime uses private subnets and the service-owned group while retaining its artifact and identity', () => {
  const stack = new Stack(new App(), 'Test');
  const runtime = new CfnRuntime(stack, 'Runtime', {
    agentRuntimeName: 'test_runtime',
    roleArn: 'arn:aws:iam::123456789012:role/test',
    agentRuntimeArtifact: {
      containerConfiguration: { containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test:unchanged' },
    },
    networkConfiguration: { networkMode: 'PUBLIC' },
  });
  applyRuntimeNetwork(runtime, {
    securityGroupParameterName: '/test/agent-network',
    subnetIds: ['subnet-fixture11111111', 'subnet-fixture22222222'],
  });
  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: 'test_runtime',
    RoleArn: 'arn:aws:iam::123456789012:role/test',
    AgentRuntimeArtifact: {
      ContainerConfiguration: { ContainerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test:unchanged' },
    },
    NetworkConfiguration: {
      NetworkMode: 'VPC',
      NetworkModeConfig: {
        Subnets: ['subnet-fixture11111111', 'subnet-fixture22222222'],
        SecurityGroups: [Match.anyValue()],
      },
    },
  });
});

test.each([
  ['a security group parameter', { securityGroupParameterName: '', subnetIds: ['subnet-fixture11111111'] }],
  ['private subnets', { securityGroupParameterName: '/test/agent-network', subnetIds: [] }],
])('runtime VPC networking without %s fails loud', (_missing, network) => {
  const runtime = new CfnRuntime(new Stack(new App(), 'Test'), 'Runtime', {
    agentRuntimeName: 'test_runtime',
    roleArn: 'arn:aws:iam::123456789012:role/test',
    agentRuntimeArtifact: { containerConfiguration: { containerUri: 'test:latest' } },
    networkConfiguration: { networkMode: 'PUBLIC' },
  });

  expect(() => applyRuntimeNetwork(runtime, network)).toThrow(
    new Error('Runtime VPC networking requires a security group parameter and private subnets')
  );
});
