import { CfnResource, Stack, type App } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantNetwork, isFunctionResource } from './lambda-inline-grants.js';

export interface ExistingNetwork {
  vpcId: string;
  privateSubnetIds: readonly string[];
}

/**
 * Put every Lambda function the app defines, CDK's own custom-resource handlers included, in the existing network's
 * private subnets, which bring their own egress, with an inline grant to attach there. A function already in a network
 * keeps it.
 */
export function placeLambdasInNetwork(app: App, network: ExistingNetwork): void {
  const groups = new Map<Stack, ec2.CfnSecurityGroup>();
  const groupIn = (stack: Stack) => {
    const group = groups.get(stack) ?? new ec2.CfnSecurityGroup(stack, 'ExistingNetworkLambdas', {
      vpcId: network.vpcId,
      groupDescription: "BotCube's Lambda functions in the existing network",
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
    });
    groups.set(stack, group);
    return group;
  };
  for (const fn of app.node.findAll().filter(isFunctionResource)) {
    if (hasVpcConfig(fn)) continue;
    const group = groupIn(Stack.of(fn)).attrGroupId;
    fn.addPropertyOverride('VpcConfig', { SubnetIds: [...network.privateSubnetIds], SecurityGroupIds: [group] });
    grantNetwork(fn, network.privateSubnetIds, [group]);
  }
}

function hasVpcConfig(fn: CfnResource): boolean {
  return fn instanceof lambda.CfnFunction && fn.vpcConfig !== undefined;
}
