import { CfnResource, Stack, type App } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

export interface SuppliedNetwork {
  vpcId: string;
  privateSubnetIds: readonly string[];
}

const VPC_ACCESS = 'service-role/AWSLambdaVPCAccessExecutionRole';

/**
 * Put every Lambda function the app defines, CDK's own custom-resource handlers included, in the supplied network's
 * private subnets, which bring their own egress. A function already in a network keeps it.
 */
export function placeLambdasInNetwork(app: App, network: SuppliedNetwork): void {
  const groups = new Map<Stack, ec2.CfnSecurityGroup>();
  const groupIn = (stack: Stack) => {
    const group = groups.get(stack) ?? new ec2.CfnSecurityGroup(stack, 'SuppliedNetworkLambdas', {
      vpcId: network.vpcId,
      groupDescription: "BotCube's Lambda functions in the supplied network",
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
    });
    groups.set(stack, group);
    return group;
  };
  for (const fn of app.node.findAll().filter(isFunctionResource)) {
    if (hasVpcConfig(fn)) continue;
    const stack = Stack.of(fn);
    fn.addPropertyOverride('VpcConfig', { SubnetIds: [...network.privateSubnetIds], SecurityGroupIds: [groupIn(stack).attrGroupId] });
    executionRole(fn)?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(VPC_ACCESS));
  }
}

function isFunctionResource(construct: IConstruct): construct is CfnResource {
  return construct instanceof CfnResource && construct.cfnResourceType === 'AWS::Lambda::Function';
}

function hasVpcConfig(fn: CfnResource): boolean {
  return fn instanceof lambda.CfnFunction && fn.vpcConfig !== undefined;
}

/** The role the function runs as: its L2 function's, or the `ServiceRole` beside a raw handler such as LogRetention's. */
function executionRole(fn: CfnResource): iam.IRole | undefined {
  const owner = fn.node.scope;
  if (owner instanceof lambda.Function) return owner.role;
  const sibling = owner?.node.tryFindChild('ServiceRole');
  return sibling instanceof iam.Role ? sibling : undefined;
}
