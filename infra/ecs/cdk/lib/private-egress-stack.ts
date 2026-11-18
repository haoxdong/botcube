import { CfnOutput, RemovalPolicy, Stack, type App, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { parkState } from './park-state.js';
import type { DeployIdentity } from './production-identity.js';
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
    const { egressCondition: live } = parkState(this);
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

/** The deploy's NAT, which its identity names exactly when the Deployment Config brings no existing network. */
const EGRESS_FIELDS = 'existing.network, aws.ecs.privateEgress';
const EGRESS_BOTH = 'An existing network brings its own egress, so the deploy identity names no NAT for BotCube to create and park in it';
const EGRESS_NEITHER = 'Without an existing network, the deploy identity names the NAT BotCube creates for the private subnets';

export function ownedEgress(app: App, identity: DeployIdentity, existingNetwork: boolean, boundary?: iam.IManagedPolicy): PrivateEgressStack | undefined {
  const egress = identity.aws.ecs.privateEgress;
  if (existingNetwork === Boolean(egress)) {
    throw new Error(`${EGRESS_FIELDS}: ${egress ? EGRESS_BOTH : EGRESS_NEITHER}`);
  }
  if (!egress) return undefined;
  const stack = new PrivateEgressStack(app, 'PrivateEgress', {
    env: { account: identity.aws.account, region: identity.aws.region },
    stackName: egress.stackName, natGateway: egress.natGateway, routeTableId: egress.routeTableId,
  });
  if (boundary) iam.PermissionsBoundary.of(stack).apply(boundary);
  return stack;
}
