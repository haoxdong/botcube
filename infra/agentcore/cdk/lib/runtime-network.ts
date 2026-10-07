import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Stack } from 'aws-cdk-lib';

export interface RuntimeNetwork {
  securityGroupParameterName: string;
  subnetIds: string[];
}

/** Consume the service network's owned security group without recreating it. */
export function applyRuntimeNetwork(runtime: CfnRuntime, network: RuntimeNetwork): void {
  if (!network.securityGroupParameterName || network.subnetIds.length === 0) {
    throw new Error('Runtime VPC networking requires a security group parameter and private subnets');
  }
  runtime.networkConfiguration = {
    networkMode: 'VPC',
    networkModeConfig: {
      subnets: network.subnetIds,
      securityGroups: [StringParameter.valueForStringParameter(Stack.of(runtime), network.securityGroupParameterName)],
    },
  };
}
