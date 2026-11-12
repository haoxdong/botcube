import { ArnFormat, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { DeployIdentity } from './production-identity.js';

export function parkingExecutionRole(stack: Stack, identity: DeployIdentity) {
  const { ecs } = identity.aws;
  const role = new iam.Role(stack, 'ParkingExecutionRole', {
    roleName: `${ecs.parking.functionName}-cfn-execution`,
    assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
  });
  const arn = (service: string, resource: string) => stack.formatArn({ service, resource });
  const allow = (actions: string[], resources: string[], conditions?: Record<string, Record<string, string | string[]>>) =>
    role.addToPolicy(new iam.PolicyStatement({ actions, resources, ...(conditions ? { conditions } : {}) }));
  // CloudFormation resolves every SSM-typed stack parameter on UpdateStack: the bootstrap version, and the preview origin's
  // plan-usage owner account (unpark 8980424a failed without it).
  allow(['ssm:GetParameters'], [arn('ssm', 'parameter/cdk-bootstrap/hnb659fds/version'),
    arn('ssm', `parameter${ecs.chatService.planUsageOwnerAccountParameter}`)]);
  allow(['ec2:DescribeNatGateways', 'ec2:DescribeAddresses', 'ec2:DescribeRouteTables', 'ec2:DescribeSubnets', 'ec2:DescribeNetworkInterfaces'], ['*']);
  allow(['ec2:CreateNatGateway'], [arn('ec2', 'natgateway/*')], { StringEquals: { 'aws:RequestTag/Name': ecs.privateEgress.natGateway.name } });
  allow(['ec2:CreateNatGateway'], [arn('ec2', `subnet/${ecs.privateEgress.natGateway.publicSubnetId}`), arn('ec2', `vpc/${identity.aws.credentialService.vpcId}`)]);
  allow(['ec2:CreateNatGateway'], [arn('ec2', 'elastic-ip/*')], { StringEquals: { 'ec2:PublicIpAddress': ecs.privateEgress.publicIp } });
  allow(['ec2:DeleteNatGateway'], [arn('ec2', 'natgateway/*')], { StringEquals: { 'ec2:ResourceTag/Name': ecs.privateEgress.natGateway.name } });
  allow(['ec2:CreateTags'], [arn('ec2', 'natgateway/*')], { StringEquals: { 'ec2:CreateAction': 'CreateNatGateway' } });
  allow(['ec2:CreateRoute', 'ec2:DeleteRoute'], [arn('ec2', `route-table/${ecs.privateEgress.routeTableId}`)]);
  const elbResources = ['loadbalancer/app/*', 'listener/app/*', 'listener-rule/app/*', 'targetgroup/*'].map(resource => arn('elasticloadbalancing', resource));
  allow(['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:CreateListener', 'elasticloadbalancing:CreateRule'], elbResources,
    { StringEquals: { 'aws:RequestTag/parking-stack': ecs.previewOriginStackName } });
  allow(['elasticloadbalancing:AddTags'], elbResources, { StringEquals: {
    'elasticloadbalancing:CreateAction': ['CreateLoadBalancer', 'CreateListener', 'CreateRule'],
    'aws:RequestTag/parking-stack': ecs.previewOriginStackName,
  } });
  allow(['elasticloadbalancing:DeleteLoadBalancer', 'elasticloadbalancing:ModifyLoadBalancerAttributes',
    'elasticloadbalancing:DeleteListener', 'elasticloadbalancing:ModifyListener', 'elasticloadbalancing:ModifyListenerAttributes', 'elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates',
    'elasticloadbalancing:DeleteRule', 'elasticloadbalancing:ModifyRule', 'elasticloadbalancing:SetRulePriorities', 'elasticloadbalancing:ModifyTargetGroupAttributes'],
  elbResources, { StringEquals: { 'aws:ResourceTag/parking-stack': ecs.previewOriginStackName } });
  allow(['elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeLoadBalancerAttributes', 'elasticloadbalancing:DescribeListeners',
    'elasticloadbalancing:DescribeListenerCertificates', 'elasticloadbalancing:DescribeListenerAttributes', 'elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeTargetGroups',
    'elasticloadbalancing:DescribeTargetGroupAttributes', 'elasticloadbalancing:DescribeTags', 'elasticloadbalancing:DescribeTrustStores',
    'elasticloadbalancing:DescribeTrustStoreAssociations'], ['*']);
  allow(['ecs:DescribeServices', 'ecs:UpdateService', 'ecs:TagResource', 'ecs:UntagResource'],
    ['chat-service-preview', 'credential-service'].map(name => arn('ecs', `service/${ecs.cluster}/${name}`)));
  allow(['events:DescribeRule', 'events:PutRule', 'events:PutTargets', 'events:RemoveTargets', 'events:ListTargetsByRule'],
    [arn('events', `rule/${ecs.previewOriginStackName}-ChatServiceReaperSchedule*`)]);
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: `role/${ecs.previewOriginStackName}-ChatServiceReaperInvocati*` })],
    { StringEquals: { 'iam:PassedToService': 'events.amazonaws.com' } });
  allow(['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms'],
    [ecs.apiHealth.alarmName, ...['task-deficit', 'alb-5xx', 'target-5xx', 'unhealthy-hosts'].map(suffix => `${ecs.cluster}-preview-${suffix}`)]
      .map(name => stack.formatArn({ service: 'cloudwatch', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'alarm', resourceName: name })));
  allow(['lambda:InvokeFunction'], [`${ecs.previewOriginStackName}-OriginProviderframework*`, `${ecs.apiHealth.stackName}-AWS679f53fac002430cb0da5b798*`]
    .map(name => stack.formatArn({ service: 'lambda', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'function', resourceName: name })));
  return role;
}
