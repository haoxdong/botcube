import { App, AspectPriority, Aspects, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantLambdasInline } from '../lib/lambda-inline-grants';
import * as fs from 'node:fs';
import * as path from 'node:path';

const copy = (cdkPackage: string) => fs.readFileSync(path.resolve(__dirname, `../../../${cdkPackage}/cdk/lib/lambda-inline-grants.ts`), 'utf8');

test("matches the AgentCore package's copy byte for byte, since neither package's build can import the other's source", () => {
  expect(copy('ecs')).toBe(copy('agentcore'));
});

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
