import { App, AspectPriority, Aspects, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantLambdasInline } from 'botcube-config/lambda-inline-grants';

test('keeps a managed policy attached by a landing-zone aspect', () => {
  const stack = new Stack(new App(), 'LandingZone');
  const handler = new lambda.Function(stack, 'Handler', {
    runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
  grantLambdasInline(stack);
  const policyArn = 'arn:aws:iam::123456789012:policy/LandingZone';
  const policy = iam.ManagedPolicy.fromManagedPolicyArn(stack, 'LandingZonePolicy', policyArn);
  Aspects.of(stack).add({
    visit(node) {
      if (node === handler.node.defaultChild) handler.role?.addManagedPolicy(policy);
    },
  }, { priority: AspectPriority.DEFAULT });
  Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: [policyArn] });
});
