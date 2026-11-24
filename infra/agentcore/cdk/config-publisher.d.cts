import type { Stack } from 'aws-cdk-lib';
import type { IRole } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export function publishConfig(
  stack: Stack,
  configPath: string
): {
  locator: string;
  grantRead(role: IRole, consumer: Construct): void;
};
