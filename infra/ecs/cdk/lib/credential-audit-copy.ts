import { Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import type { Construct } from 'constructs';

/** The Credential Service image: the task runs the service, and the audit-copy Lambda runs the image's audit-copy handler. */
export interface CredentialServiceImage {
  readonly service: ecs.ContainerImage;
  readonly auditCopy: lambda.DockerImageCode;
}

/** The Credential Service image built once from `directory`: the same asset backs the task and the audit-copy Lambda. */
export function credentialServiceImage(directory: string, props: ecs.AssetImageProps): CredentialServiceImage {
  return { service: ecs.ContainerImage.fromAsset(directory, props), auditCopy: lambda.DockerImageCode.fromImageAsset(directory, props) };
}

/** Copies the service's audit events into a group kept a year, with a Lambda run from the Credential Service image. */
export function copyAuditEvents(scope: Construct, source: logs.LogGroup, auditLogGroupName: string, image: CredentialServiceImage, existingFunctionsKeyArn?: string) {
  // The construct id 'Logs' fixes the CloudFormation logical id, so the deployed group is updated in place, not replaced.
  const logGroup = new logs.LogGroup(scope, 'Logs', { logGroupName: auditLogGroupName, retention: logs.RetentionDays.ONE_YEAR });
  const copy = new lambda.DockerImageFunction(scope, 'AuditCopy', {
    code: image.auditCopy, architecture: lambda.Architecture.X86_64,
    ...(existingFunctionsKeyArn ? { environmentEncryption: kms.Key.fromKeyArn(scope, 'FunctionsKey', existingFunctionsKeyArn) } : {}),
    timeout: Duration.seconds(30), memorySize: 128,
    environment: { AUDIT_LOG_GROUP: logGroup.logGroupName },
    logGroup: new logs.LogGroup(scope, 'AuditCopyLogs', { retention: logs.RetentionDays.ONE_MONTH }),
  });
  (copy.node.defaultChild as lambda.CfnFunction).imageConfig = {
    entryPoint: ['python', '-m', 'awslambdaric'], command: ['botcube_credential_service.audit_copy.handler'],
  };
  copy.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }));
  const subscription = new logs.SubscriptionFilter(scope, 'AuditEvents', {
    logGroup: source, destination: new destinations.LambdaDestination(copy),
    filterPattern: logs.FilterPattern.literal('{ $.event = * && $.accountId = * }'),
  });
  return { logGroup, copy, subscription };
}
