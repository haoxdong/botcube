import type { Stack } from 'aws-cdk-lib';
import type { IPrincipal } from 'aws-cdk-lib/aws-iam';
import type { Alias, Function } from 'aws-cdk-lib/aws-lambda';

export function sessionApiExports(
  stack: Stack,
  functionName: string
): {
  invokeArn: string;
  capacity: {
    functionName: string;
    alias: string;
    resourceId: string;
    serviceNamespace: string;
    scalableDimension: string;
  };
  addAlias(fn: Function): Alias;
  grantInvoke(role: IPrincipal): void;
  grantCapacityControl(role: IPrincipal): void;
};
