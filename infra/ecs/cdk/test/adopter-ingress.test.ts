import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { PreviewChatService, type PreviewChatServiceProps, type ChatServiceIngress } from '../lib/preview-chat-service.js';

function compose(overrides: Partial<PreviewChatServiceProps> = {}, second = false, priorities: [number, number] = [101, 102], owned = false) {
  const stack = new Stack(new App(), 'Adopter', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', { vpcId: 'vpc-fixture12345678', availabilityZones: ['us-east-1a', 'us-east-1b'] });
  const securityGroup = owned ? new ec2.SecurityGroup(stack, 'OwnedIngress', { vpc, allowAllOutbound: false }) : ec2.SecurityGroup.fromSecurityGroupId(stack, 'Ingress', 'sg-fixture11111111', { mutable: false });
  const loadBalancer = elb.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(stack, 'Alb', {
    loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/adopter/fixture',
    securityGroupId: securityGroup.securityGroupId, loadBalancerCanonicalHostedZoneId: 'FIXTURE', loadBalancerDnsName: 'adopter.example.com',
  });
  const listener = elb.ApplicationListener.fromApplicationListenerAttributes(stack, 'Listener', {
    listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/adopter/fixture/listener', securityGroup,
  });
  const ingress: ChatServiceIngress = { securityGroup, loadBalancer, listener, cdpRulePriority: priorities[0], chatRulePriority: priorities[1] };
  const props: PreviewChatServiceProps = {
    ingress,
    vpcId: 'vpc-fixture12345678', privateSubnets: [{ id: 'subnet-fixture11111111', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture22222222', availabilityZone: 'us-east-1b' }],
    clusterName: 'adopter', alertsTopicName: 'alerts', hostnames: ['chat.example.com'], corsOrigins: [],
    memoryId: 'memory-AbCd', runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
    sessionApiFunctionName: 'session-api', sessionApiAlias: 'live', reaperCommand: ['node', 'reap.js'], authBrowserId: 'browser-AbCd',
    chatTable: dynamodb.Table.fromTableName(stack, 'Table', 'adopter-chat'), image: ContainerImage.fromRegistry('test-image'), parked: false, ...overrides,
  };
  new PreviewChatService(stack, 'Chat', props);
  if (second) new PreviewChatService(stack, 'OtherChat', { ...props, clusterName: 'other', serviceName: 'other-chat', hostnames: ['other.example.com'], ingress: { securityGroup, loadBalancer, listener, cdpRulePriority: 201, chatRulePriority: 202 } });
  return Template.fromStack(stack);
}

test('Chat Service composes with imported ingress without managing the shared ALB or unrelated hosts', () => {
  const template = compose();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
  template.resourceCountIs('AWS::Lambda::Function', 0);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 101, Conditions: [
      { Field: 'host-header', HostHeaderConfig: { Values: ['chat.example.com'] } },
      { Field: 'path-pattern', PathPatternConfig: { Values: ['/agent-computer/cdp*'] } },
    ], Actions: [Match.objectLike({ Type: 'fixed-response' })],
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', { Priority: 102, Actions: [Match.objectLike({ Type: 'forward' })] });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { SourceSecurityGroupId: 'sg-fixture11111111', FromPort: 8123, ToPort: 8123 });
  template.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
  template.hasResourceProperties('AWS::ECS::Service', { LoadBalancers: [Match.objectLike({ ContainerPort: 8123 })] });
});


test('two Chat Services can reserve separate rules on one imported listener', () => {
  const template = compose({}, true);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 4);
  expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))).not.toContain('OriginHttpsChatServiceGroup7CF46779');
});

test('adopter ALB settings cannot be overwritten by Chat Service configuration', () => {
  expect(() => compose({ loadBalancerIdleSeconds: 60 })).toThrow('Adopter owns shared ALB idle timeout');
});

test.each([[0, 102], [101, 50001], [1.5, 102], [102, 102], [103, 102]])('invalid adopter listener priorities %j are rejected', (cdp, chat) => {
  expect(() => compose({}, false, [cdp, chat])).toThrow('Chat Service ingress requires distinct listener priorities');
});

test('Chat Service does not grant outbound access on an adopter-owned restrictive ingress security group', () => {
  const template = compose({}, false, [101, 102], true);
  template.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Adopter/OwnedIngress',
    SecurityGroupEgress: [{ CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic', FromPort: 252, IpProtocol: 'icmp', ToPort: 86 }],
  });
});


test('shared ingress alarms cover only this Chat Service target group', () => {
  const template = compose();
  expect(Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(alarm => alarm.Properties.MetricName)).not.toContain('HTTPCode_ELB_5XX_Count');
  for (const MetricName of ['HTTPCode_Target_5XX_Count', 'UnHealthyHostCount']) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName, Dimensions: Match.arrayWith([{ Name: 'TargetGroup', Value: Match.anyValue() }]) });
  }
});
