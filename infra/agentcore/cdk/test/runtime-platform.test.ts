import { App, Stack } from 'aws-cdk-lib';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { applyRuntimePlatform } from '../lib/runtime-platform';

test.each(['V1', 'V2'] as const)('platform %s configures the snapshot hook only for V2', platform => {
  const stack = new Stack(new App(), 'Test');
  const runtime = new CfnRuntime(stack, 'Runtime', {
    agentRuntimeName: 'test_runtime',
    roleArn: 'arn:aws:iam::123456789012:role/test',
    agentRuntimeArtifact: { containerConfiguration: { containerUri: 'test:latest' } },
    networkConfiguration: { networkMode: 'PUBLIC' },
  });
  applyRuntimePlatform(runtime, platform);
  Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    PlatformVersion: platform,
    HooksConfiguration:
      platform === 'V2'
        ? { Build: { Warmup: { Action: { HttpPost: { Path: '/warmup', Port: 8080 } } } } }
        : Match.absent(),
  });
});
