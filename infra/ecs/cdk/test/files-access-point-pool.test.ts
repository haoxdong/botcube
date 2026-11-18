import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FilesAccessPointPool } from '../lib/files-access-point-pool.js';

test('allows the intentional worker chain bounded by Count and the five-receive dead-letter policy', () => {
  const stack = new Stack(new App(), 'PoolTest');
  new FilesAccessPointPool(stack, 'Pool', {
    fileSystemId: 'fs-test', fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-test',
    capacity: 1000, source: path.resolve(__dirname, '../../files-pool'),
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.worker', RecursiveLoop: 'Allow', ReservedConcurrentExecutions: 1,
  });
  template.hasResourceProperties('AWS::CloudFormation::CustomResource', { Count: 1000 });
  const [worker] = Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { Handler: 'index.worker' } }));
  const [queue] = Object.keys(template.findResources('AWS::SQS::Queue', { Properties: { RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }) } }));
  if (!worker || !queue) throw new Error('Pool requires its worker and bounded build queue');
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    FunctionName: { Ref: worker }, EventSourceArn: { 'Fn::GetAtt': [queue, 'Arn'] }, BatchSize: 1,
  });
});
