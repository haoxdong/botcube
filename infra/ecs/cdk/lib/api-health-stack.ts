import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface ApiHealthStackProps extends StackProps {
  /** The production API hostname, probed at `/health` through Cloudflare. */
  requestIntervalSeconds?: number;
  failureThreshold?: number;
  evaluationPeriods?: number;
  hostname: string;
  alarmName: string;
  alertsTopicName: string;
  /** Parked disables the check and silences its alarm; Live restores both. */
  parked: boolean;
}

/**
 * The Route 53 health check on the production API and its alarm. Both were built by hand and are imported, never created
 * (docs/runbooks/aws-alerting-stack.md), so the check's ID, which the
 * observability dashboard reads, survives.
 */
export class ApiHealthStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiHealthStackProps) {
    super(scope, id, props);
    const check = new route53.CfnHealthCheck(this, 'ApiHealthCheck', {
      healthCheckConfig: {
        type: 'HTTPS', fullyQualifiedDomainName: props.hostname, port: 443, resourcePath: '/health',
        requestInterval: props.requestIntervalSeconds ?? 30, failureThreshold: props.failureThreshold ?? 3, measureLatency: true, enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: props.alarmName }],
    });
    check.applyRemovalPolicy(RemovalPolicy.DESTROY);
    // CloudFormation's HealthCheckConfig has no Disabled property, so set it through the Route 53 API.
    const disabled: cr.AwsSdkCall = {
      service: 'Route53', action: 'updateHealthCheck',
      parameters: { HealthCheckId: check.ref, Disabled: props.parked },
      physicalResourceId: cr.PhysicalResourceId.of('ApiHealthCheckDisabled'),
    };
    new cr.AwsCustomResource(this, 'ApiHealthCheckDisabled', {
      onCreate: disabled, onUpdate: disabled, installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: ['route53:UpdateHealthCheck'], resources: [`arn:aws:route53:::healthcheck/${check.ref}`],
      })]),
    });
    const alarm = new cloudwatch.Alarm(this, 'ApiHealthAlarm', {
      alarmName: props.alarmName,
      alarmDescription: `${props.hostname}/health failing from Route 53 checkers`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Route53', metricName: 'HealthCheckStatus', dimensionsMap: { HealthCheckId: check.ref },
        statistic: 'Minimum', period: Duration.minutes(1),
      }),
      threshold: 1, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: props.evaluationPeriods ?? 2, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled: !props.parked,
    });
    alarm.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const topic = sns.Topic.fromTopicArn(this, 'Alerts', this.formatArn({ service: 'sns', resource: props.alertsTopicName }));
    alarm.addAlarmAction(new actions.SnsAction(topic));
    alarm.addOkAction(new actions.SnsAction(topic));
    new CfnOutput(this, 'HealthCheckId', { value: check.ref });
    new CfnOutput(this, 'AlarmName', { value: alarm.alarmName });
  }
}
