import { parkingTemplate } from './resolve-parking.js';
import { App } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { ApiHealthStack } from '../lib/api-health-stack';

test.each([true, false])('base health checks remain with paid options removed, parked=%s', (parked) => {
  const template = parkingTemplate(new ApiHealthStack(new App(), 'Health', {
    hostname: 'api.example.com', alarmName: 'health', alertsTopicName: 'alerts',
  }), parked);
  template.hasResourceProperties('AWS::Route53::HealthCheck', {
    HealthCheckConfig: {
      Type: 'HTTP', Port: 80, FullyQualifiedDomainName: 'api.example.com', ResourcePath: '/health',
      RequestInterval: 30, FailureThreshold: 3, MeasureLatency: false,
    },
  });
  if (parked) { template.resourceCountIs('AWS::CloudWatch::Alarm', 0); return; }
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    ActionsEnabled: !parked, Dimensions: [{ Name: 'HealthCheckId', Value: { Ref: 'ApiHealthCheck' } }],
    AlarmActions: Match.anyValue(), OKActions: Match.anyValue(),
  });
});

test('parked production has no paid health alarm', () => {
  const template = parkingTemplate(new ApiHealthStack(new App(), 'ParkedHealth', {
    hostname: 'api.example.com', alarmName: 'health', alertsTopicName: 'alerts',
  }), true);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
});

test.each([true, false])('the Runtime alarms and their log filter stay on in every mode, parked=%s', (parked) => {
  const template = parkingTemplate(new ApiHealthStack(new App(), 'RuntimeHealth', {
    hostname: 'api.example.com', alarmName: 'health', alertsTopicName: 'alerts',
    runtime: { name: 'agent_runtime', arnParameter: '/agent/runtime-arn', alarmPrefix: 'agent-runtime', filterName: 'agent-runtime-error-lines', metricNamespace: 'Agent' },
  }), parked);
  const topic = [Match.objectLike({ 'Fn::Join': Match.anyValue() })];
  const arn = { Ref: Match.stringLikeRegexp('^SsmParameterValue') };
  const dimensions = [{ Name: 'Resource', Value: arn }, { Name: 'Operation', Value: 'InvokeAgentRuntime' }, { Name: 'Name', Value: 'agent_runtime::DEFAULT' }];
  const shared = { ActionsEnabled: true, AlarmActions: topic, Statistic: 'Sum', EvaluationPeriods: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' };
  template.resourceCountIs('AWS::CloudWatch::Alarm', parked ? 4 : 5);
  template.hasResource('AWS::CloudWatch::Alarm', { DeletionPolicy: 'Retain', Properties: { ...shared, AlarmName: 'agent-runtime-log-errors', Namespace: 'Agent', MetricName: 'RuntimeLogErrors', Period: 300, Threshold: 3, OKActions: [], Dimensions: [] } });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { ...shared, AlarmName: 'agent-runtime-system-errors', MetricName: 'SystemErrors', Period: 300, Threshold: 1, OKActions: topic, Dimensions: dimensions });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { ...shared, AlarmName: 'agent-runtime-throttles', MetricName: 'Throttles', Period: 300, Threshold: 1, OKActions: [], Dimensions: dimensions });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { ...shared, AlarmName: 'agent-runtime-user-errors', MetricName: 'UserErrors', Period: 900, Threshold: 5, OKActions: [], Dimensions: dimensions });
  template.hasResource('AWS::Logs::MetricFilter', { DeletionPolicy: 'Retain', Properties: {
    FilterName: 'agent-runtime-error-lines', FilterPattern: '?ERROR ?Exception ?Traceback',
    LogGroupName: { 'Fn::Join': ['', ['/aws/bedrock-agentcore/runtimes/', { 'Fn::Select': [1, { 'Fn::Split': [':runtime/', arn] }] }, '-DEFAULT']] },
    MetricTransformations: [{ MetricName: 'RuntimeLogErrors', MetricNamespace: 'Agent', MetricValue: '1', DefaultValue: 0 }],
  } });
});
