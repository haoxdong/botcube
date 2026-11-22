import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { secretResource } from 'botcube-config/read';
import type { Construct } from 'constructs';

/** Let the task read the Credential Sources' secrets, each by its name, in this stack's account and region, or its ARN. */
export function grantSecretReads(scope: Construct, task: { addToTaskRolePolicy(statement: iam.PolicyStatement): void }, secretIds: readonly string[]): void {
  if (!secretIds.length) return;
  const stack = Stack.of(scope);
  task.addToTaskRolePolicy(
    new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: secretIds.map((secretId) => secretResource(secretId, stack)) }),
  );
}
