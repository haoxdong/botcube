import { parkingTemplate } from './resolve-parking.js';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { ok as assert } from 'node:assert';
import { App, CfnParameter, Fn } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { repositoryRoot, caPath, originProviderPath } from './origin-fixture';
import { ChatStorageStack } from '../lib/chat-storage-stack.js';
import { PreviewChatService, type PreviewChatServiceProps } from '../lib/preview-chat-service.js';
import { PreviewOriginStack } from '../lib/preview-origin-stack.js';

const privateSubnets = [{ id: 'subnet-fixture33333333', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture44444444', availabilityZone: 'us-east-1b' }];

function synth(runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime', parked = false, subnets = privateSubnets, overrides: Partial<PreviewChatServiceProps> | ((origin: PreviewOriginStack) => Partial<PreviewChatServiceProps>) = {}) {
  const app = new App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const storage = new ChatStorageStack(app, 'Storage', { env });
  const origin = new PreviewOriginStack(app, 'Origin', {
    env, hostname: 'preview.example.com', production: { hostname: 'api.example.com' }, repositoryRoot, originProviderPath,
    vpcId: 'vpc-fixture12345678', publicSubnets: [{ id: 'subnet-fixture11111111', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture22222222', availabilityZone: 'us-east-1b' }],
    cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', tokenSecretName: '/test/token', clientSecretName: '/test/client',
    caPath, corsOrigins: [], parkedDnsTarget: 'parked.invalid', wakeUrl: 'https://wake.example.com/',
  });
  new PreviewChatService(origin, 'ChatService', {
    vpcId: 'vpc-fixture12345678', privateSubnets: subnets,
    clusterName: 'test', alertsTopicName: 'existing-alerts', hostnames: ['preview.example.com', 'api.example.com'], corsOrigins: ['https://example.com', 'https://web.example.com'],
    runtimeArn, sessionApiFunctionName: 'test-session-api', sessionApiAlias: 'live', chatTable: storage.chatTable as ITable, image: ContainerImage.fromRegistry('test-image'), ...(typeof overrides === 'function' ? overrides(origin) : overrides),
  });
  return parkingTemplate(origin, parked);
}

/** The security group a construct path created, as the template references it. */
function group(template: Template, path: string) {
  const [id] = Object.keys(template.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: path } }));
  return { 'Fn::GetAtt': [id, 'GroupId'] };
}

test('private service replaces before stopping, rolls back failure and uses storage readiness', () => {
  const template = synth();
  const ingress = group(template, 'Origin/ChatService/Ingress');
  const alb = group(template, 'Origin/OriginIngress');
  template.hasResourceProperties('AWS::ECS::Service', {
    DesiredCount: 1, LaunchType: 'FARGATE',
    NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', Subnets: ['subnet-fixture33333333', 'subnet-fixture44444444'], SecurityGroups: [ingress] } },
    DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/health', Matcher: { HttpCode: '200' }, TargetType: 'ip',
    HealthCheckIntervalSeconds: 5, HealthCheckTimeoutSeconds: 4, HealthyThresholdCount: 2, UnhealthyThresholdCount: 6,
    TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '3600' }]),
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '3600' }]),
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', { Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['preview.example.com', 'api.example.com'] } }] });
  expect(Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => rule.Properties)).toEqual([
    { GroupId: ingress, SourceSecurityGroupId: alb, IpProtocol: 'tcp', FromPort: 8123, ToPort: 8123, Description: 'Preview ALB only' },
  ]);
  expect(Object.values(template.findResources('AWS::EC2::SecurityGroupEgress')).map(rule => rule.Properties)).toEqual([
    { GroupId: alb, DestinationSecurityGroupId: ingress, IpProtocol: 'tcp', FromPort: 8123, ToPort: 8123, Description: 'Preview ALB only' },
  ]);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'AGENTCORE_RUNTIME_ARN', Value: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime' },
      { Name: 'BOTCUBE_CHAT_TABLE', Value: Match.anyValue() },
    ]) })]),
  });
  const policies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.includes('ChatServiceTaskTaskRole'));
  expect(policies).toHaveLength(1);
  const [policy] = policies;
  assert(policy);
  const statements = policy[1].Properties.PolicyDocument.Statement;
  expect(statements).toEqual(expect.arrayContaining([
    expect.objectContaining({ Action: expect.arrayContaining(['dynamodb:DescribeTable', 'dynamodb:ConditionCheckItem']) }),
    expect.objectContaining({ Action: 'bedrock-agentcore:InvokeAgentRuntime', Resource: ['arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime/runtime-endpoint/*'] }),
  ]));
  expect(statements).toEqual(expect.arrayContaining([expect.objectContaining({ Action: 'bedrock-agentcore:ConnectBrowserLiveViewStream', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1']] } })]));
  expect(JSON.stringify(statements)).not.toMatch(/kms:|credential-vault|secretsmanager:/);
});

test('the Chat Service alone stops Sessions on its configured runtime before purging', () => {
  const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/purge-runtime';
  const template = synth(runtimeArn);
  const statements = Object.entries(template.findResources('AWS::IAM::Policy'))
    .flatMap(([id, policy]) => policy.Properties.PolicyDocument.Statement.map((statement: object) => ({ id, ...statement })))
    .filter(statement => JSON.stringify(statement).includes('bedrock-agentcore:StopRuntimeSession'));
  expect(statements).toEqual([
    expect.objectContaining({ id: expect.stringContaining('ChatServiceTaskTaskRole'), Action: 'bedrock-agentcore:StopRuntimeSession', Resource: [runtimeArn, `${runtimeArn}/runtime-endpoint/*`] }),
  ]);
});

test('the Chat Service alone invokes the session API, through the alias kept initialized', () => {
  const template = synth();
  const functionArn = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] };
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'BOTCUBE_SESSION_API_FUNCTION_ARN', Value: functionArn },
    ]) })]),
  });
  const statements = Object.entries(template.findResources('AWS::IAM::Policy'))
    .flatMap(([id, policy]) => policy.Properties.PolicyDocument.Statement.map((statement: object) => ({ id, ...statement })))
    .filter(statement => JSON.stringify(statement).includes('test-session-api'));
  expect(statements).toEqual([
    expect.objectContaining({ id: expect.stringContaining('ChatServiceTaskTaskRole'), Action: 'lambda:InvokeFunction', Resource: functionArn }),
  ]);
});

test('allows only the live session API alias after the unqualified rollout drains', () => {
  const template = synth();
  const statements = named(template, 'ChatServiceTaskTaskRoleDefaultPolicy').Properties.PolicyDocument.Statement
    .filter((statement: { Effect: string; Action: string }) => statement.Effect === 'Allow' && statement.Action === 'lambda:InvokeFunction');
  const grants = statements.flatMap((statement: { Resource: unknown }) => Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]);

  expect(grants).toEqual([
    { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] },
  ]);
});

test('a failed Session purge alarms on the existing alert owner', () => {
  const template = synth();
  const [filterId] = Object.keys(template.findResources('AWS::Logs::MetricFilter'));
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '"Session purge failed"',
    MetricTransformations: [{ MetricNamespace: 'BotCube/ChatService', MetricName: 'SessionPurgeFailures', MetricValue: '1' }],
  });
  expect(filterId).toBeDefined();
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'test-session-purge-failures',
    Namespace: 'BotCube/ChatService', MetricName: 'SessionPurgeFailures', Statistic: 'Sum',
    Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', EvaluationPeriods: 1, DatapointsToAlarm: 1, TreatMissingData: 'notBreaching',
    AlarmActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
    OKActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
  });
});

test('a Turn whose Files could not be mounted alarms on the existing alert owner', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '"code=FILES_MOUNT"',
    MetricTransformations: [{ MetricNamespace: 'BotCube/ChatService', MetricName: 'FilesMountFailures', MetricValue: '1' }],
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'test-files-mount-failures',
    Namespace: 'BotCube/ChatService', MetricName: 'FilesMountFailures', Statistic: 'Sum',
    Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', EvaluationPeriods: 1, DatapointsToAlarm: 1, TreatMissingData: 'notBreaching',
    AlarmActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
  });
});

test('a failed Turn summary alarms on the existing alert owner', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '"Turn summary failed"',
    MetricTransformations: [{ MetricNamespace: 'BotCube/ChatService', MetricName: 'TurnSummaryFailures', MetricValue: '1' }],
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'test-turn-summary-failures',
    Namespace: 'BotCube/ChatService', MetricName: 'TurnSummaryFailures', Statistic: 'Sum',
    Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', EvaluationPeriods: 1, DatapointsToAlarm: 1, TreatMissingData: 'notBreaching',
    AlarmActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
  });
});

test('a failed sleep of Agent Computer browsers at task stop alarms on the existing alert owner', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '"Agent Computer sleep at task stop failed"',
    MetricTransformations: [{ MetricNamespace: 'BotCube/ChatService', MetricName: 'AgentComputerStopSleepFailures', MetricValue: '1' }],
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'test-agent-computer-stop-sleep-failures',
    Namespace: 'BotCube/ChatService', MetricName: 'AgentComputerStopSleepFailures', Statistic: 'Sum',
    Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', EvaluationPeriods: 1, DatapointsToAlarm: 1, TreatMissingData: 'notBreaching',
    AlarmActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
    OKActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
  });
});

test('every error line counts on one Errors metric, whose filter the error grouper reads its matcher from', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '?"Error" ?"ERROR" ?"Exception" ?"failed"',
    MetricTransformations: [{ MetricNamespace: 'BotCube/ChatService', MetricName: 'Errors', MetricValue: '1' }],
  });
  const alarmed = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(alarm => alarm.Properties.MetricName);
  expect(alarmed).not.toContain('Errors');
});

test.each([
  '', 'arn:wrong', 'xarn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime\n',
])('missing or malformed runtime fails synthesis: %j', value => {
  expect(() => synth(value)).toThrow(new Error('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN'));
});

test('one private subnet fails synthesis', () => {
  expect(() => synth(undefined, false, privateSubnets.slice(0, 1))).toThrow(new Error('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN'));
});

test('availability alarms use free metrics and publish only to the existing alert owner', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
  });
  template.resourceCountIs('AWS::SNS::Topic', 0);
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'))
    .map(resource => resource.Properties)
    .filter(alarm => alarm.AlarmName.startsWith('test-preview-'));
  expect(alarms).toHaveLength(4);
  for (const alarm of alarms) {
    expect(alarm.AlarmActions).toEqual([{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }]);
    expect(alarm.OKActions).toEqual(alarm.AlarmActions);
    expect(alarm.ComparisonOperator).toBe(alarm.AlarmName.endsWith('-task-deficit') ? 'LessThanThreshold' : 'GreaterThanThreshold');
    expect(alarm.Threshold).toBe(alarm.AlarmName.endsWith('-task-deficit') ? 1 : 0);
    expect(alarm.EvaluationPeriods).toBe(3);
    expect(alarm.DatapointsToAlarm).toBe(3);
  }
  const deficit = alarms.find(alarm => alarm.AlarmName.endsWith('-task-deficit'));
  expect(deficit).toMatchObject({
    Namespace: 'AWS/ECS', MetricName: 'CPUUtilization', Statistic: 'SampleCount', Period: 60, TreatMissingData: 'breaching',
    Dimensions: [{ Name: 'ClusterName', Value: { Ref: expect.any(String) } }, { Name: 'ServiceName', Value: { 'Fn::GetAtt': [expect.any(String), 'Name'] } }],
  });
  for (const name of ['HTTPCode_ELB_5XX_Count', 'HTTPCode_Target_5XX_Count', 'UnHealthyHostCount']) {
    const alarm = alarms.find(value => value.MetricName === name);
    expect(alarm.Namespace).toBe('AWS/ApplicationELB');
    expect(alarm.Period).toBe(60);
    expect(alarm.Statistic).toBe(name === 'UnHealthyHostCount' ? 'Minimum' : 'Sum');
    expect(alarm.TreatMissingData).toBe('notBreaching');
    expect(alarm.Dimensions.map((dimension: { Name: string }) => dimension.Name).sort()).toEqual(
      name === 'HTTPCode_ELB_5XX_Count' ? ['LoadBalancer'] : ['LoadBalancer', 'TargetGroup']);
  }
});

test('parked Chat has no paid serving alarms or failure metrics', () => {
  const template = synth(undefined, true);
  template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  const filters = Object.values(template.findResources('AWS::Logs::MetricFilter'));
  expect(filters.flatMap(filter => filter.Properties.MetricTransformations.map((metric: { MetricName: string }) => metric.MetricName))).not.toContain('FilesMountFailures');
});

/** The resource a logical ID prefix names, with its logical ID. */
function named(template: Template, prefix: string) {
  const [entry] = Object.entries(template.toJSON().Resources as ReturnType<Template['findResources']>).filter(([key]) => key.startsWith(prefix));
  assert(entry, `no resource named ${prefix}`);
  const [id, resource] = entry;
  return { id, Properties: resource.Properties };
}
const alerts = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] };

test('Chat exports Turn traces through a bounded local ADOT collector to the existing X-Ray destination', () => {
  const template = synth();
  const task = named(template, 'ChatServiceTask5').Properties;
  const collector = task.ContainerDefinitions.find((container: { Name: string }) => container.Name === 'otel-collector');
  expect(collector).toMatchObject({
    Essential: false,
    Image: 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0',
    Memory: 256,
    Command: ['--config=env:OTEL_CONFIG'],
  });
  const config = JSON.parse(collector.Environment.find((entry: { Name: string }) => entry.Name === 'OTEL_CONFIG').Value);
  expect(config.receivers).toEqual({ otlp: { protocols: { http: { endpoint: '127.0.0.1:4318' } } } });
  expect(config.service.pipelines).toEqual({ traces: { receivers: ['otlp'], processors: ['memory_limiter', 'batch'], exporters: ['awsxray'] } });
  expect(config.processors.memory_limiter).toEqual({ check_interval: '1s', limit_mib: 192, spike_limit_mib: 32 });
  expect(collector.PortMappings).toBeUndefined();
  expect(named(template, 'ChatServiceTaskTaskRoleDefaultPolicy').Properties.PolicyDocument.Statement).toContainEqual({
    Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], Effect: 'Allow', Resource: '*',
  });
});

test('the Chat Service container serves port 8123 on Linux x86-64 with its full environment and 30 days of logs (ADR 0085)', () => {
  const template = synth();
  const task = named(template, 'ChatServiceTask5').Properties;
  const logs = named(template, 'ChatServiceLogs');
  expect(task).toMatchObject({ Cpu: '512', Memory: '1024', RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' } });
  expect(task.ContainerDefinitions.filter((container: { Name: string }) => container.Name === 'chat-service')).toEqual([{
    Name: 'chat-service', Essential: true, Image: 'test-image', PortMappings: [{ ContainerPort: 8123, Protocol: 'tcp' }], StopTimeout: 120,
    DependsOn: [{ ContainerName: 'otel-collector', Condition: 'START' }],
    Environment: [
      { Name: 'AWS_DEFAULT_REGION', Value: 'us-east-1' },
      { Name: 'AGENTCORE_REGION', Value: 'us-east-1' },
      { Name: 'AGENTCORE_RUNTIME_ARN', Value: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime' },
      { Name: 'BOTCUBE_SESSION_API_FUNCTION_ARN', Value: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] } },
      { Name: 'AGENTCORE_BROWSER_ID', Value: 'aws.browser.v1' },
      { Name: 'BOTCUBE_CHAT_TABLE', Value: { 'Fn::ImportValue': 'Storage:ExportsOutputRefChatTable7A2D1C242A7F282B' } },
      { Name: 'BOTCUBE_CORS_ORIGINS', Value: 'https://example.com,https://web.example.com' },
      { Name: 'OTEL_TRACES_EXPORTER', Value: 'otlp' },
      { Name: 'OTEL_LOG_LEVEL', Value: 'error' },
      { Name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', Value: 'http://127.0.0.1:4318/v1/traces' },
      { Name: 'PORT', Value: '8123' },
      { Name: 'BOTCUBE_SCHEDULE_GROUP', Value: 'test-scheduled-tasks' },
      { Name: 'BOTCUBE_SCHEDULER_ROLE_ARN', Value: { 'Fn::GetAtt': ['ChatServiceScheduledRunsRole997CC8CF', 'Arn'] } },
      { Name: 'BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', Value: { 'Fn::GetAtt': ['ChatServiceScheduledRunsD4286EBE', 'Arn'] } },
      { Name: 'BOTCUBE_SCHEDULED_RUNS_QUEUE_URL', Value: { Ref: 'ChatServiceScheduledRunsD4286EBE' } },
    ],
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: logs.id }, 'awslogs-stream-prefix': 'chat-service', 'awslogs-region': 'us-east-1' } },
  }]);
  expect(logs.Properties).toEqual({ LogGroupName: '/test/chat-service-preview', RetentionInDays: 30 });
});

test('the service joins the ALB as chat-service-preview on port 8123 after a minute of grace', () => {
  const template = synth();
  const group = 'OriginHttpsChatServiceGroup7CF46779';
  expect(named(template, 'ChatService018D98F5').Properties).toMatchObject({
    ServiceName: 'chat-service-preview', HealthCheckGracePeriodSeconds: 60,
    LoadBalancers: [{ ContainerName: 'chat-service', ContainerPort: 8123, TargetGroupArn: { Ref: group } }],
  });
  expect(named(template, group).Properties).toMatchObject({ Port: 8123, Protocol: 'HTTP', VpcId: 'vpc-fixture12345678' });
  expect(named(template, 'OriginHttpsChatServiceRule').Properties).toMatchObject({ Priority: 10, Actions: [{ TargetGroupArn: { Ref: group }, Type: 'forward' }] });
});

test('the public ALB never forwards the Chat Service CDP channel, which the harness reaches over Cloud Map', () => {
  const template = synth();
  const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).map(rule => rule.Properties);
  const cdp = rules.filter(rule => JSON.stringify(rule.Conditions).includes('/agent-computer/cdp'));
  expect(cdp).toEqual([{
    ListenerArn: expect.anything(),
    Priority: 5,
    Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['preview.example.com', 'api.example.com'] } }, { Field: 'path-pattern', PathPatternConfig: { Values: ['/agent-computer/cdp*'] } }],
    Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not Found\n' } }],
  }]);
  const forward = rules.find(rule => rule.Actions[0].Type === 'forward');
  expect(cdp[0].Priority).toBeLessThan(forward.Priority);
});

test('the Chat Service task role grants only its data, runtime, session API, live view, task descriptions, trace export and scheduled tasks', () => {
  const template = synth();
  const statements = named(template, 'ChatServiceTaskTaskRoleDefaultPolicy').Properties.PolicyDocument.Statement;
  expect(statements.slice(2)).toEqual([
    { Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow', Resource: ['arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime/runtime-endpoint/*'] },
    { Action: 'bedrock-agentcore:StopRuntimeSession', Effect: 'Allow', Resource: ['arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime/runtime-endpoint/*'] },
    { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] } },
    { Action: 'bedrock-agentcore:ConnectBrowserLiveViewStream', Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1']] } },
    {
      Action: 'ecs:DescribeTasks', Effect: 'Allow',
      Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ecs:us-east-1:123456789012:task/test/*']] },
      Condition: { ArnEquals: { 'ecs:cluster': { 'Fn::GetAtt': [expect.stringContaining('ChatServiceCluster'), 'Arn'] } } },
    },
    { Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], Effect: 'Allow', Resource: '*' },
    {
      Action: ['sqs:ReceiveMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueUrl', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      Effect: 'Allow', Resource: { 'Fn::GetAtt': ['ChatServiceScheduledRunsD4286EBE', 'Arn'] },
    },
    {
      Action: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
      Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':scheduler:us-east-1:123456789012:schedule/test-scheduled-tasks/*']] },
    },
    {
      Action: 'scheduler:GetScheduleGroup',
      Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':scheduler:us-east-1:123456789012:schedule-group/test-scheduled-tasks']] },
    },
    { Action: 'iam:PassRole', Effect: 'Allow', Resource: { 'Fn::GetAtt': ['ChatServiceScheduledRunsRole997CC8CF', 'Arn'] } },
  ]);
});

test('the origin outputs the Chat Service ids the Smoke Test reads', () => {
  const template = synth();
  const outputs = template.toJSON().Outputs;
  expect(Object.fromEntries(Object.keys(outputs).slice(7).map(name => [name, outputs[name].Value]))).toEqual({
    AlertsTopicArn: alerts,
    ClusterName: { Ref: named(template, 'ChatServiceCluster').id },
    ServiceName: { 'Fn::GetAtt': ['ChatService018D98F5', 'Name'] },
    TaskDefinitionArn: { Ref: named(template, 'ChatServiceTask5').id },
    ChatTableName: { 'Fn::ImportValue': 'Storage:ExportsOutputRefChatTable7A2D1C242A7F282B' },
    TargetGroupArn: { Ref: 'OriginHttpsChatServiceGroup7CF46779' },
  });
});

test('scheduled tasks fire through a schedule group into a queue only the Chat Service reads', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'test-scheduled-tasks' });
  template.hasResourceProperties('AWS::SQS::Queue', {
    VisibilityTimeout: 900,
    MessageRetentionPeriod: 1209600,
    RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 3 },
  });
  // Runs that failed every delivery stay two weeks for inspection.
  template.hasResourceProperties('AWS::SQS::Queue', { MessageRetentionPeriod: 1209600 });
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })] }),
  });
  const policies = Object.entries(template.findResources('AWS::IAM::Policy'));
  const actions = (fragment: string) => policies
    .filter(([id]) => id.includes(fragment))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) => statement.Action));
  expect(actions('ScheduledRunsRole')).toEqual(expect.arrayContaining(['sqs:SendMessage']));
});

test('the Chat Service keeps no Turn Memory signing secret', () => {
  synth().resourceCountIs('AWS::SecretsManager::Secret', 0);
});

test('a configured browser uses its account-owned IAM resource for live-view access', () => {
  const browserId = 'corporate_login-AbCdEfGhIj';
  const template = synth(undefined, false, privateSubnets, { browserId });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'AGENTCORE_BROWSER_ID', Value: browserId },
    ]) })]),
  });
  const statements = Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.includes('ChatServiceTaskTaskRole'))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
  expect(statements.filter(statement => statement.Action === 'bedrock-agentcore:ConnectBrowserLiveViewStream')).toEqual([{
    Action: 'bedrock-agentcore:ConnectBrowserLiveViewStream', Effect: 'Allow',
    Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock-agentcore:us-east-1:123456789012:browser-custom/${browserId}`]] },
  }]);
});


test('an imported runtime ARN survives the environment and invocation grants', () => {
  const template = synth(Fn.importValue('AdopterRuntimeArn'), false, privateSubnets);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'AGENTCORE_RUNTIME_ARN', Value: { 'Fn::ImportValue': 'AdopterRuntimeArn' } },
    ]) })]),
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
    Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow', Resource: [
      { 'Fn::ImportValue': 'AdopterRuntimeArn' },
      { 'Fn::Join': ['', [{ 'Fn::ImportValue': 'AdopterRuntimeArn' }, '/runtime-endpoint/*']] },
    ],
  }]) } });
});


test('a parameter runtime composes with the default AgentCore Harness', () => {
  const template = synth(undefined, false, privateSubnets, origin => ({
    runtimeArn: new CfnParameter(origin, 'AdopterRuntimeArn', { type: 'String' }).valueAsString,
  }));
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'AGENTCORE_RUNTIME_ARN', Value: { Ref: 'AdopterRuntimeArn' } },
    ]) })]),
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
    Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow', Resource: [
      { Ref: 'AdopterRuntimeArn' }, { 'Fn::Join': ['', [{ Ref: 'AdopterRuntimeArn' }, '/runtime-endpoint/*']] },
    ],
  }]) } });
});

test('adopter names reach Chat tasks, roles, queues, ingress and alarms', () => {
  const template = synth(undefined, false, privateSubnets, {
    metricFilterNames: { sessionPurgeFailures: 'adopter-purge-filter', turnSummaryFailures: 'adopter-summary-filter', agentComputerStopSleepFailures: 'adopter-sleep-filter', errors: 'adopter-errors-filter' },
    taskFamily: 'adopter-chat-task',
    taskRoleName: 'adopter-chat-role', executionRoleName: 'adopter-chat-execution',
    scheduledRunsQueueName: 'adopter-runs', scheduledRunsFailedQueueName: 'adopter-failed',
    scheduledRunsRoleName: 'adopter-scheduler',
    securityGroupName: 'adopter-chat-network',
    targetGroupName: 'adopter-chat-target',
    alarmNames: { 'task-deficit': 'adopter-deficit', 'alb-5xx': 'adopter-alb-errors', 'session-purge-failures': 'adopter-purge-errors' },
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: 'adopter-chat-task' });
  for (const RoleName of ['adopter-chat-role', 'adopter-chat-execution', 'adopter-scheduler']) template.hasResourceProperties('AWS::IAM::Role', { RoleName });
  for (const QueueName of ['adopter-runs', 'adopter-failed']) template.hasResourceProperties('AWS::SQS::Queue', { QueueName });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'adopter-chat-network' });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Name: 'adopter-chat-target' });
  for (const AlarmName of ['adopter-deficit', 'adopter-alb-errors', 'adopter-purge-errors']) template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName });
  for (const FilterName of ['adopter-purge-filter', 'adopter-summary-filter', 'adopter-sleep-filter', 'adopter-errors-filter']) template.hasResourceProperties('AWS::Logs::MetricFilter', { FilterName });
  expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))).toEqual(['OriginHttpsChatServiceGroup7CF46779']);
});

test('an adopter scheduled queue is consumed without replacement', () => {
  const template = synth(undefined, false, privateSubnets, origin => ({
    scheduledRunsQueue: sqs.Queue.fromQueueArn(origin, 'OwnedQueue', 'arn:aws:sqs:us-east-1:123456789012:owned-runs'),
  }));
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      Environment: Match.arrayWith([{ Name: 'BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', Value: 'arn:aws:sqs:us-east-1:123456789012:owned-runs' }]),
    })]),
  });
});

test('imported Chat resources own their names and queue redrive settings', () => {
  expect(() => synth(undefined, false, privateSubnets, origin => ({
    executionRole: iam.Role.fromRoleArn(origin, 'OwnedRole', 'arn:aws:iam::123456789012:role/owned-execution', { mutable: false }), executionRoleName: 'replacement',
  }))).toThrow('imported executionRole owns its name');
  expect(() => synth(undefined, false, privateSubnets, origin => ({
    scheduledRunsQueue: sqs.Queue.fromQueueArn(origin, 'OwnedQueue', 'arn:aws:sqs:us-east-1:123456789012:owned-runs'), scheduledRunsFailedQueueName: 'replacement',
  }))).toThrow('imported scheduledRunsQueue owns its name and redrive settings');
});

test('a raw HTTP hostname forwards even paths private to the Chat Service', () => {
  const template = synth(undefined, false, privateSubnets, { rawHostnames: ['gateway.example.com'] });
  const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).map(rule => rule.Properties);
  const cdp = rules.find(rule => JSON.stringify(rule.Conditions).includes('/agent-computer/cdp'));
  expect(cdp.Conditions).toContainEqual({ Field: 'host-header', HostHeaderConfig: { Values: ['preview.example.com', 'api.example.com'] } });
  const forward = rules.find(rule => rule.Actions[0].Type === 'forward');
  expect(forward.Conditions).toEqual([{ Field: 'host-header', HostHeaderConfig: { Values: ['preview.example.com', 'api.example.com', 'gateway.example.com'] } }]);
});
