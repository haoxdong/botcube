import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/**
 * A runtime's telemetry: it may send traces to X-Ray, and the log group AgentCore (not CloudFormation)
 * creates for it, named after its id, keeps 30 days (ADR 0085 decision 2).
 */
export function configureRuntimeTelemetry(scope: Construct, id: string, runtimeId: string, role: iam.IRole): void {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] })
  );
  new logs.LogRetention(scope, id, {
    logGroupName: `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`,
    retention: logs.RetentionDays.ONE_MONTH,
  });
}
