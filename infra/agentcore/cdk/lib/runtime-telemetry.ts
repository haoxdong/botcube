import { runtimeLogGroupName } from 'botcube-infra-agentcore-cdk/exports';
import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { secretResource } from 'botcube-config/read';
import type { Construct } from 'constructs';
import type { RuntimeTelemetry } from '../../../../config/seams.js' with { 'resolution-mode': 'import' };

/**
 * Grant reads of telemetry credentials and retain the Runtime's logs for 30 days (ADR 0085 decision 2).
 */
export function configureRuntimeTelemetry(
  scope: Construct,
  id: string,
  runtimeId: string,
  role: iam.IRole,
  telemetry: RuntimeTelemetry
): void {
  if (telemetry.secretIds.length)
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: telemetry.secretIds.map(secretId => secretResource(secretId, Stack.of(scope))),
      })
    );
  new logs.LogRetention(scope, id, {
    logGroupName: runtimeLogGroupName(runtimeId),
    retention: logs.RetentionDays.ONE_MONTH,
  });
}
