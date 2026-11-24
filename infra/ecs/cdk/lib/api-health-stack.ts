import { runtimeLogGroupName } from 'botcube-infra-agentcore-cdk/exports';
import { CfnOutput, CfnResource, Fn, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { conditionalResource, parkState } from './park-state.js';
import { Construct } from 'constructs';

export interface ApiHealthStackProps extends StackProps {
  /** The production API hostname, probed at `/health` through Cloudflare. */
  requestIntervalSeconds?: number;
  failureThreshold?: number;
  evaluationPeriods?: number;
  hostname: string;
  alarmName: string;
  alertsTopicName: string;
  /** The bot's AgentCore Runtime, the SSM parameter holding its current ARN, and its monitoring names. */
  runtime?: RuntimeMonitoring;
}

interface RuntimeMonitoring {
  name: string;
  arnParameter: string;
  /** Prefix of the four alarm names, e.g. `<prefix>-log-errors`. */
  alarmPrefix: string;
  filterName: string;
  /** Namespace of the log-error metric the filter publishes. */
  metricNamespace: string;
}

// The four Runtime alarms and their filter were built by hand and are imported, never created; Retain keeps them if a
// deploy from an older template drops them. Continuously enabled: a parked Runtime emits nothing, so they stay quiet.
const RUNTIME_ALARMS = [
  { id: 'RuntimeLogErrors', suffix: 'log-errors', namespace: undefined, metricName: 'RuntimeLogErrors', period: 300, threshold: 3, notifyOnOk: false,
    alarmDescription: '3+ ERROR/Exception/Traceback lines in runtime logs within 5 min (near-realtime)' },
  { id: 'RuntimeSystemErrors', suffix: 'system-errors', namespace: 'AWS/Bedrock-AgentCore', metricName: 'SystemErrors', period: 300, threshold: 1, notifyOnOk: true,
    alarmDescription: 'AgentCore runtime 5xx (service-side) errors' },
  { id: 'RuntimeThrottles', suffix: 'throttles', namespace: 'AWS/Bedrock-AgentCore', metricName: 'Throttles', period: 300, threshold: 1, notifyOnOk: false,
    alarmDescription: 'AgentCore runtime throttling' },
  { id: 'RuntimeUserErrors', suffix: 'user-errors', namespace: 'AWS/Bedrock-AgentCore', metricName: 'UserErrors', period: 900, threshold: 5, notifyOnOk: false,
    alarmDescription: 'AgentCore runtime 4xx errors (bad requests/auth) - sustained' },
];

/**
 * The Route 53 health check on the production API and its alarm. Both were built by hand and are imported, never created
 * (ops/credentials/aws-alerting-stack.md), so the check's ID, which the
 * observability dashboard reads, survives.
 */
export class ApiHealthStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiHealthStackProps) {
    super(scope, id, props);
    const state = parkState(this);
    const check = new route53.CfnHealthCheck(this, 'ApiHealthCheck', {
      healthCheckConfig: {
        type: 'HTTP', fullyQualifiedDomainName: props.hostname, port: 80, resourcePath: '/health',
        requestInterval: props.requestIntervalSeconds ?? 30, failureThreshold: props.failureThreshold ?? 3, measureLatency: false,
      },
      healthCheckTags: [{ key: 'Name', value: props.alarmName }],
    });
    check.applyRemovalPolicy(RemovalPolicy.DESTROY);
    // CloudFormation's HealthCheckConfig has no Disabled property, so set it through the Route 53 API.
    const disabled: cr.AwsSdkCall = {
      service: 'Route53', action: 'updateHealthCheck',
      parameters: { HealthCheckId: check.ref, Disabled: false },
      physicalResourceId: cr.PhysicalResourceId.of('ApiHealthCheckDisabled'),
    };
    const toggle = new cr.AwsCustomResource(this, 'ApiHealthCheckDisabled', {
      onCreate: disabled, onUpdate: disabled, installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: ['route53:UpdateHealthCheck'], resources: [`arn:aws:route53:::healthcheck/${check.ref}`],
      })]),
    });
    const call = (parked: boolean) => this.toJsonString({
      service: 'Route53', action: 'updateHealthCheck', parameters: { HealthCheckId: check.ref, Disabled: parked },
      physicalResourceId: { id: 'ApiHealthCheckDisabled' },
    });
    const resource = toggle.node.findChild('Resource').node.defaultChild as CfnResource;
    for (const operation of ['Create', 'Update']) resource.addPropertyOverride(operation, Fn.conditionIf(state.parkedCondition.logicalId, call(true), call(false)));
    const alarm = new cloudwatch.Alarm(this, 'ApiHealthAlarm', {
      alarmName: props.alarmName, actionsEnabled: true,
      alarmDescription: `${props.hostname}/health failing from Route 53 checkers`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Route53', metricName: 'HealthCheckStatus', dimensionsMap: { HealthCheckId: check.ref },
        statistic: 'Minimum', period: Duration.minutes(1),
      }),
      threshold: 1, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: props.evaluationPeriods ?? 2, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    conditionalResource(this, alarm);
    alarm.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const topic = sns.Topic.fromTopicArn(this, 'Alerts', this.formatArn({ service: 'sns', resource: props.alertsTopicName }));
    alarm.addAlarmAction(new actions.SnsAction(topic));
    alarm.addOkAction(new actions.SnsAction(topic));
    if (props.runtime) runtimeAlarms(this, props.runtime, topic.topicArn);
    new CfnOutput(this, 'HealthCheckId', { value: check.ref });
    new CfnOutput(this, 'AlarmName', { value: props.alarmName });
  }
}

function runtimeAlarms(stack: Stack, runtime: RuntimeMonitoring, topicArn: string) {
  const arn = ssm.StringParameter.valueForStringParameter(stack, runtime.arnParameter);
  const filter = new logs.CfnMetricFilter(stack, 'RuntimeErrorLines', {
    filterName: runtime.filterName, filterPattern: '?ERROR ?Exception ?Traceback',
    logGroupName: runtimeLogGroupName(Fn.select(1, Fn.split(':runtime/', arn))),
    metricTransformations: [{ metricName: 'RuntimeLogErrors', metricNamespace: runtime.metricNamespace, metricValue: '1', defaultValue: 0 }],
  });
  filter.applyRemovalPolicy(RemovalPolicy.RETAIN);
  for (const { id, suffix, notifyOnOk, namespace, ...alarm } of RUNTIME_ALARMS) {
    new cloudwatch.CfnAlarm(stack, id, {
      ...alarm, alarmName: `${runtime.alarmPrefix}-${suffix}`, namespace: namespace ?? runtime.metricNamespace, actionsEnabled: true, alarmActions: [topicArn], okActions: notifyOnOk ? [topicArn] : [], statistic: 'Sum', evaluationPeriods: 1,
      comparisonOperator: 'GreaterThanOrEqualToThreshold', treatMissingData: 'notBreaching',
      dimensions: namespace === 'AWS/Bedrock-AgentCore'
        ? [{ name: 'Resource', value: arn }, { name: 'Operation', value: 'InvokeAgentRuntime' }, { name: 'Name', value: `${runtime.name}::DEFAULT` }] : [],
    }).applyRemovalPolicy(RemovalPolicy.RETAIN);
  }
}
