import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { RuntimeTelemetry } from '../../../../config/seams.js' with { 'resolution-mode': 'import' };

/**
 * A runtime's telemetry: under `xray` it may send traces to X-Ray, under `otlp` read its Endpoint's credential secret,
 * and under `none` neither; the log group AgentCore (not CloudFormation) creates for it, named after its id, keeps
 * 30 days (ADR 0085 decision 2).
 */
export function configureRuntimeTelemetry(
  scope: Construct,
  id: string,
  runtimeId: string,
  role: iam.IRole,
  telemetry: RuntimeTelemetry
): void {
  if (telemetry.kind === 'xray')
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] })
    );
  if (telemetry.secretArns.length)
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [...telemetry.secretArns] })
    );
  new logs.LogRetention(scope, id, {
    logGroupName: `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`,
    retention: logs.RetentionDays.ONE_MONTH,
  });
}
