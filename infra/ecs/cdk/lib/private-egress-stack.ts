import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { parkState } from './park-state.js';
import { Construct } from 'constructs';

export interface PrivateEgressStackProps extends StackProps {
  natGateway: { name: string; publicSubnetId: string };
  routeTableId: string;
}

/**
 * The private subnets' NAT egress (ADR 0065 decision 4). The Elastic IP is the
 * fixed credential egress IP: it is imported, never created, and always retained
 * (docs/runbooks/private-nat-gateway.md). Parked production has no NAT
 * Gateway or default route (docs/runbooks/production-parking.md).
 */
export class PrivateEgressStack extends Stack {
  constructor(scope: Construct, id: string, props: PrivateEgressStackProps) {
    super(scope, id, props);
    const address = new ec2.CfnEIP(this, 'PrivateNatAddress', { domain: 'vpc' });
    address.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'PrivateNatPublicIp', { value: address.ref });
    new CfnOutput(this, 'PrivateNatAllocationId', { value: address.attrAllocationId });
    const { liveCondition: live } = parkState(this);
    const gateway = new ec2.CfnNatGateway(this, 'PrivateNatGateway', {
      allocationId: address.attrAllocationId,
      subnetId: props.natGateway.publicSubnetId,
      connectivityType: 'public',
      tags: [{ key: 'Name', value: props.natGateway.name }],
    });
    gateway.cfnOptions.condition = live;
    gateway.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const route = new ec2.CfnRoute(this, 'PrivateNatDefaultRoute', {
      routeTableId: props.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: gateway.ref,
    });
    route.cfnOptions.condition = live;
    route.applyRemovalPolicy(RemovalPolicy.DESTROY);
    new CfnOutput(this, 'PrivateNatGatewayId', { value: gateway.ref, condition: live });
  }
}
