import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { cartridgeIdentity } from '../lib/cartridge.js';
import { parkingExecutionRole } from '../lib/parking-execution-role.js';

const identity = cartridgeIdentity(path.resolve(__dirname, '../../../../templates/always-on/deploy'));
const stack = new Stack(new App(), 'ExecutionBoundary', { env: { account: identity.aws.account, region: identity.aws.region } });
parkingExecutionRole(stack, identity);
const template = Template.fromStack(stack);
const statement = (properties: object) => template.hasResourceProperties('AWS::IAM::Policy', {
  PolicyDocument: { Statement: Match.arrayWith([Match.objectLike(properties)]) },
});

test('allows the parking service update on only the two existing services', () => {
  statement({
    Action: ['ecs:DescribeServices', 'ecs:UpdateService', 'ecs:TagResource', 'ecs:UntagResource'],
    Resource: stack.resolve(['service/bot-cube/chat-service-preview', 'service/bot-cube/credential-service']
      .map(resource => stack.formatArn({ service: 'ecs', resource }))),
  });
});

test('limits NAT deletion, routes and load balancer changes to parking resources', () => {
  statement({ Action: 'ec2:DeleteNatGateway', Condition: { StringEquals: { 'ec2:ResourceTag/Name': 'bot-cube-private-egress' } } });
  statement({ Action: ['ec2:CreateRoute', 'ec2:DeleteRoute'], Resource: stack.resolve(stack.formatArn({ service: 'ec2', resource: 'route-table/rtb-placeholder' })) });
  statement({ Action: ['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:CreateListener', 'elasticloadbalancing:CreateRule'],
    Condition: { StringEquals: { 'aws:RequestTag/parking-stack': 'bot-cube-preview-origin' } } });
  statement({ Action: Match.arrayWith(['elasticloadbalancing:DeleteLoadBalancer', 'elasticloadbalancing:ModifyTargetGroupAttributes']),
    Condition: { StringEquals: { 'aws:ResourceTag/parking-stack': 'bot-cube-preview-origin' } } });
});

test('has no administrator attachment, IAM mutation, data mutation or Lambda configuration grants', () => {
  template.allResourcesProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  for (const forbidden of ['AdministratorAccess', 'iam:*', 'iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy',
    'sts:AssumeRole', 'dynamodb:', 'kms:', 'secretsmanager:', 's3:', 'lambda:UpdateFunction', 'ecs:RegisterTaskDefinition',
    'ec2:ReleaseAddress', 'ec2:AllocateAddress', 'ec2:DeleteVpc', 'elasticloadbalancing:*']) {
    expect(policies).not.toContain(forbidden);
  }
  statement({ Action: 'iam:PassRole', Condition: { StringEquals: { 'iam:PassedToService': 'events.amazonaws.com' } } });
  template.allResourcesProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.not(Match.arrayWith([
    Match.objectLike({ Action: 'iam:PassRole', Resource: '*' }),
  ])) } });
});
