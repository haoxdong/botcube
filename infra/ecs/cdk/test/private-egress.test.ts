import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PrivateEgressStack } from '../lib/private-egress-stack.js';

const EGRESS = {
  natGateway: { name: 'test-private-egress', publicSubnetId: 'subnet-fixture0fedcba9876543210' },
  routeTableId: 'rtb-placeholder',
  parked: false,
};

function synth(): Template {
  return Template.fromStack(new PrivateEgressStack(new App(), 'TestEgress', EGRESS));
}

test('the Elastic IP is retained so the fixed egress IP survives any stack change', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::EIP', 1);
  // Logical IDs match the AgentCore stack's, which the import mapping names.
  expect(template.toJSON().Resources.PrivateNatAddress).toEqual({
    Type: 'AWS::EC2::EIP',
    Properties: { Domain: 'vpc' },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('the NAT Gateway uses the retained Elastic IP in the configured public subnet', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  // Create-only properties equal the live Gateway's, so the import never replaces it.
  expect(template.toJSON().Resources.PrivateNatGateway).toEqual({
    Type: 'AWS::EC2::NatGateway',
    Properties: {
      AllocationId: { 'Fn::GetAtt': ['PrivateNatAddress', 'AllocationId'] },
      SubnetId: EGRESS.natGateway.publicSubnetId,
      ConnectivityType: 'public',
      Tags: [{ Key: 'Name', Value: EGRESS.natGateway.name }],
    },
    DeletionPolicy: 'Delete',
    UpdateReplacePolicy: 'Delete',
  });
});

test('the private default route sends all egress through the NAT Gateway', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::Route', 1);
  template.resourceCountIs('Custom::AWS', 0);
  expect(template.toJSON().Resources.PrivateNatDefaultRoute).toEqual({
    Type: 'AWS::EC2::Route',
    Properties: {
      RouteTableId: EGRESS.routeTableId,
      DestinationCidrBlock: '0.0.0.0/0',
      NatGatewayId: { Ref: 'PrivateNatGateway' },
    },
    DeletionPolicy: 'Delete',
    UpdateReplacePolicy: 'Delete',
  });
});

test('the stack reports the egress identity', () => {
  const template = synth();
  template.hasOutput('PrivateNatGatewayId', { Value: { Ref: 'PrivateNatGateway' } });
  template.hasOutput('PrivateNatPublicIp', { Value: { Ref: 'PrivateNatAddress' } });
  template.hasOutput('PrivateNatAllocationId', { Value: { 'Fn::GetAtt': ['PrivateNatAddress', 'AllocationId'] } });
});
