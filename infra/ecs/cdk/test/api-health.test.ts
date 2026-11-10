import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiHealthStack } from '../lib/api-health-stack';

test.each([true, false])('base health checks remain with paid options removed, parked=%s', (parked) => {
  const template = Template.fromStack(new ApiHealthStack(new App(), 'Health', {
    hostname: 'api.example.com', alarmName: 'health', alertsTopicName: 'alerts', parked,
  }));
  template.hasResourceProperties('AWS::Route53::HealthCheck', {
    HealthCheckConfig: {
      Type: 'HTTP', Port: 80, FullyQualifiedDomainName: 'api.example.com', ResourcePath: '/health',
      RequestInterval: 30, FailureThreshold: 3, MeasureLatency: false,
    },
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    ActionsEnabled: !parked, Dimensions: [{ Name: 'HealthCheckId', Value: { Ref: 'ApiHealthCheck' } }],
    AlarmActions: Match.anyValue(), OKActions: Match.anyValue(),
  });
});
