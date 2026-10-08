import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
  const storage = new ChatStorageStack(app, 'Storage', { env, corsOrigins: [] });
  const origin = new PreviewOriginStack(app, 'Origin', {
    env, hostname: 'preview.example.com', production: { hostname: 'api.example.com' }, repositoryRoot, originProviderPath,
    vpcId: 'vpc-fixture12345678', publicSubnets: [{ id: 'subnet-fixture11111111', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture22222222', availabilityZone: 'us-east-1b' }],
    cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', tokenSecretName: '/test/token', clientSecretName: '/test/client',
    caPath, corsOrigins: [], parked, parkedDnsTarget: 'parked.invalid',
  });
  new PreviewChatService(origin, 'ChatService', {
    vpcId: 'vpc-fixture12345678', privateSubnets: subnets,
    clusterName: 'test', alertsTopicName: 'existing-alerts', hostnames: ['preview.example.com', 'api.example.com'], corsOrigins: ['https://example.com', 'https://web.example.com'],
    runtimeArn, memoryId: 'test_memory-AbCdEfGhIj', sessionApiFunctionName: 'test-session-api', sessionApiAlias: 'live', reaperCommand: ['node', 'test-reap-auth-browsers.js'], authBrowserId: 'test_credential_login-1234567890', chatTable: storage.chatTable as ITable, image: ContainerImage.fromRegistry('test-image'), parked, ...(typeof overrides === 'function' ? overrides(origin) : overrides),
  });
  return Template.fromStack(origin);
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
    expect.objectContaining({ id: expect.stringContaining('ChatServiceTaskTaskRole'), Action: 'lambda:InvokeFunction', Resource: [
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api']] }, functionArn,
    ] }),
  ]);
});

test('keeps draining tasks able to invoke their unqualified session API while replacement tasks call live', () => {
  const template = synth();
  const statements = named(template, 'ChatServiceTaskTaskRoleDefaultPolicy').Properties.PolicyDocument.Statement
    .filter((statement: { Effect: string; Action: string }) => statement.Effect === 'Allow' && statement.Action === 'lambda:InvokeFunction');
  const grants = statements.flatMap((statement: { Resource: unknown }) => Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]);

  expect(grants).toHaveLength(2);
  expect(grants).toEqual(expect.arrayContaining([
    { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api']] },
    { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] },
  ]));
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

test.each([
  '', 'arn:wrong', 'xarn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime\n',
])('missing or malformed runtime fails synthesis: %j', value => {
  expect(() => synth(value)).toThrow(new Error('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN'));
});

test('one private subnet fails synthesis', () => {
  expect(() => synth(undefined, false, privateSubnets.slice(0, 1))).toThrow(new Error('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN'));
});

test('availability alarms collect task metrics and publish only to the existing alert owner', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
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
  expect(deficit.TreatMissingData).toBe('breaching');
  expect(deficit.Metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ Expression: 'running / desired', ReturnData: true }),
    ...[['desired', 'DesiredTaskCount'], ['running', 'RunningTaskCount']].map(([id, name]) => expect.objectContaining({
      Id: id, ReturnData: false, MetricStat: { Period: 60, Stat: 'Average', Metric: {
        Namespace: 'ECS/ContainerInsights', MetricName: name,
        Dimensions: [{ Name: 'ClusterName', Value: { Ref: expect.any(String) } }, { Name: 'ServiceName', Value: { 'Fn::GetAtt': [expect.any(String), 'Name'] } }],
      } },
    })),
  ]));
  // Exercise the asserted `running / desired` expression and comparison against explicit cases.
  const ratio = (running: number, desired: number) => running / desired;
  for (const [running, desired, breaches] of [[1, 1, false], [0, 1, true], [1, 2, true], [2, 1, false]] as [number, number, boolean][]) {
    expect(ratio(running, desired) < deficit.Threshold).toBe(breaches);
  }
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

test('reaper schedule uses the service image in private subnets and targets the canonical auth browser', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(5 minutes)', State: 'ENABLED',
    Targets: [Match.objectLike({
      EcsParameters: Match.objectLike({
        LaunchType: 'FARGATE', TaskCount: 1,
        NetworkConfiguration: { AwsVpcConfiguration: {
          AssignPublicIp: 'DISABLED', Subnets: ['subnet-fixture33333333', 'subnet-fixture44444444'], SecurityGroups: [group(template, 'Origin/ChatService/ReaperNetwork')],
        } },
      }),
    })],
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [Match.objectLike({
      Image: 'test-image', Command: ['node', 'test-reap-auth-browsers.js'],
      Environment: Match.arrayWith([{ Name: 'AGENTCORE_BROWSER_ID', Value: 'test_credential_login-1234567890' }]),
      LogConfiguration: Match.objectLike({ LogDriver: 'awslogs' }),
    })],
  });
  const policies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.includes('ReaperTaskTaskRole'));
  expect(policies).toHaveLength(1);
  const [policy] = policies;
  assert(policy);
  expect(policy[1].Properties.PolicyDocument.Statement).toEqual([expect.objectContaining({
    Action: ['bedrock-agentcore:ListBrowserSessions', 'bedrock-agentcore:StopBrowserSession'],
    Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:123456789012:browser-custom/test_credential_login-1234567890']] },
  })]);
});

test('scheduler may run only its revision in its cluster and pass only its task roles', () => {
  const template = synth();
  const [ruleResource] = Object.values(template.findResources('AWS::Events::Rule'));
  assert(ruleResource);
  const rule = ruleResource.Properties;
  const target = rule.Targets[0];
  const policies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.includes('ReaperInvocationRole'));
  expect(policies).toHaveLength(1);
  const [policy] = policies;
  assert(policy);
  expect(policy[1].Properties.PolicyDocument.Statement).toEqual([
    { Action: 'ecs:RunTask', Effect: 'Allow', Resource: target.EcsParameters.TaskDefinitionArn,
      Condition: { ArnEquals: { 'ecs:cluster': target.Arn } } },
    { Action: 'iam:PassRole', Effect: 'Allow', Resource: expect.arrayContaining([
      { 'Fn::GetAtt': [expect.stringContaining('ReaperTaskTaskRole'), 'Arn'] },
      { 'Fn::GetAtt': [expect.stringContaining('ReaperTaskExecutionRole'), 'Arn'] },
    ]), Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
  ]);
});

/** The resource a logical ID prefix names, with its logical ID. */
function named(template: Template, prefix: string) {
  const [entry] = Object.entries(template.toJSON().Resources as ReturnType<Template['findResources']>).filter(([key]) => key.startsWith(prefix));
  assert(entry, `no resource named ${prefix}`);
  const [id, resource] = entry;
  return { id, Properties: resource.Properties };
}
const alerts = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] };

test('the Chat Service container serves port 8123 on Linux x86-64 with its full environment and a week of logs', () => {
  const template = synth();
  const task = named(template, 'ChatServiceTask5').Properties;
  const logs = named(template, 'ChatServiceLogs');
  expect(task).toMatchObject({ Cpu: '512', Memory: '1024', RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' } });
  expect(task.ContainerDefinitions).toEqual([{
    Name: 'chat-service', Essential: true, Image: 'test-image', PortMappings: [{ ContainerPort: 8123, Protocol: 'tcp' }], StopTimeout: 120,
    Environment: [
      { Name: 'AWS_DEFAULT_REGION', Value: 'us-east-1' },
      { Name: 'AGENTCORE_REGION', Value: 'us-east-1' },
      { Name: 'AGENTCORE_RUNTIME_ARN', Value: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime' },
      { Name: 'AGENTCORE_MEMORY_ID', Value: 'test_memory-AbCdEfGhIj' },
      { Name: 'BOTCUBE_TURN_MEMORY_URL', Value: 'https://api.example.com/internal/turn-memory' },
      { Name: 'BOTCUBE_SESSION_API_FUNCTION_ARN', Value: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] } },
      { Name: 'AGENTCORE_BROWSER_ID', Value: 'aws.browser.v1' },
      { Name: 'BOTCUBE_CHAT_TABLE', Value: { 'Fn::ImportValue': 'Storage:ExportsOutputRefChatTable7A2D1C242A7F282B' } },
      { Name: 'BOTCUBE_CORS_ORIGINS', Value: 'https://example.com,https://web.example.com' },
      { Name: 'PORT', Value: '8123' },
      { Name: 'BOTCUBE_SCHEDULE_GROUP', Value: 'test-scheduled-tasks' },
      { Name: 'BOTCUBE_SCHEDULER_ROLE_ARN', Value: { 'Fn::GetAtt': ['ChatServiceScheduledRunsRole997CC8CF', 'Arn'] } },
      { Name: 'BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', Value: { 'Fn::GetAtt': ['ChatServiceScheduledRunsD4286EBE', 'Arn'] } },
      { Name: 'BOTCUBE_SCHEDULED_RUNS_QUEUE_URL', Value: { Ref: 'ChatServiceScheduledRunsD4286EBE' } },
    ],
    Secrets: [{ Name: 'BOTCUBE_TURN_MEMORY_SECRET', ValueFrom: { Ref: named(template, 'ChatServiceTurnMemorySecret').id } }],
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: logs.id }, 'awslogs-stream-prefix': 'chat-service', 'awslogs-region': 'us-east-1' } },
  }]);
  expect(logs.Properties).toEqual({ LogGroupName: '/test/chat-service-preview', RetentionInDays: 7 });
});

test('the reaper runs a small Linux x86-64 task that names its browser and keeps a week of logs', () => {
  const template = synth();
  const task = named(template, 'ChatServiceReaperTask5').Properties;
  const logs = named(template, 'ChatServiceReaperLogs');
  expect(task).toMatchObject({ Cpu: '256', Memory: '512', RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' } });
  expect(task.ContainerDefinitions).toEqual([{
    Name: 'reaper', Essential: true, Image: 'test-image', Command: ['node', 'test-reap-auth-browsers.js'],
    Environment: [
      { Name: 'AWS_DEFAULT_REGION', Value: 'us-east-1' },
      { Name: 'AGENTCORE_REGION', Value: 'us-east-1' },
      { Name: 'AGENTCORE_BROWSER_ID', Value: 'test_credential_login-1234567890' },
    ],
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: logs.id }, 'awslogs-stream-prefix': 'reaper', 'awslogs-region': 'us-east-1' } },
  }]);
  expect(logs.Properties).toEqual({ LogGroupName: '/test/auth-browser-reaper-preview', RetentionInDays: 7 });
});

test('EventBridge runs the reaper schedule once, never retries and drops events older than a minute', () => {
  const template = synth();
  const rule = named(template, 'ChatServiceReaperSchedule').Properties;
  const role = named(template, 'ChatServiceReaperInvocationRole');
  expect(rule.Description).toBe('Expire abandoned credential login browser sessions');
  expect(rule.Targets[0]).toMatchObject({
    Id: 'Reaper', RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0 },
    RoleArn: { 'Fn::GetAtt': [role.id, 'Arn'] },
  });
  expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
    { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' } },
  ]);
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

test('the public ALB never forwards the Agent Computer CDP channel, which the harness reaches over Cloud Map', () => {
  const template = synth();
  const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).map(rule => rule.Properties);
  const cdp = rules.filter(rule => JSON.stringify(rule.Conditions).includes('/agent-computer/cdp'));
  expect(cdp).toEqual([{
    ListenerArn: expect.anything(),
    Priority: 5,
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/agent-computer/cdp*'] } }],
    Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not Found\n' } }],
  }]);
  const forward = rules.find(rule => rule.Actions[0].Type === 'forward');
  expect(cdp[0].Priority).toBeLessThan(forward.Priority);
});

test('the Chat Service task role grants only the table, runtime, Memory broker, session API, live view, task descriptions in its cluster and scheduled tasks', () => {
  const template = synth();
  const statements = named(template, 'ChatServiceTaskTaskRoleDefaultPolicy').Properties.PolicyDocument.Statement;
  expect(statements.slice(2)).toEqual([
    { Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow', Resource: ['arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime/runtime-endpoint/*'] },
    {
      Action: ['bedrock-agentcore:GetMemory', 'bedrock-agentcore:ListEvents', 'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:CreateEvent', 'bedrock-agentcore:DeleteEvent', 'bedrock-agentcore:GetMemoryRecord',
        'bedrock-agentcore:DeleteMemoryRecord', 'bedrock-agentcore:BatchUpdateMemoryRecords'],
      Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:123456789012:memory/test_memory-AbCdEfGhIj']] },
    },
    {
      Action: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'], Effect: 'Allow',
      Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:123456789012:memory/test_memory-AbCdEfGhIj']] },
      Condition: { StringLike: { 'bedrock-agentcore:namespacePath': '/strategies/*/actors/*/' } },
    },
    { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: [
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api']] },
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-1:123456789012:function:test-session-api:live']] },
    ] },
    { Action: 'bedrock-agentcore:ConnectBrowserLiveViewStream', Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1']] } },
    {
      Action: 'ecs:DescribeTasks', Effect: 'Allow',
      Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ecs:us-east-1:123456789012:task/test/*']] },
      Condition: { ArnEquals: { 'ecs:cluster': { 'Fn::GetAtt': [expect.stringContaining('ChatServiceCluster'), 'Arn'] } } },
    },
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

test('the origin outputs the Chat Service and reaper ids the Smoke Test reads', () => {
  const template = synth();
  const outputs = template.toJSON().Outputs;
  expect(Object.fromEntries(Object.keys(outputs).slice(7).map(name => [name, outputs[name].Value]))).toEqual({
    ReaperBrowserId: 'test_credential_login-1234567890',
    ReaperTaskDefinitionArn: { Ref: named(template, 'ChatServiceReaperTask5').id },
    ReaperRuleName: { Ref: named(template, 'ChatServiceReaperSchedule').id },
    ReaperLogGroupName: { Ref: named(template, 'ChatServiceReaperLogs').id },
    ReaperSecurityGroupId: group(template, 'Origin/ChatService/ReaperNetwork'),
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

test.each([undefined, true])('a signed HTTPS Harness (%s) requires a deployed AgentCore runtime ARN', harnessSigv4 => {
  for (const runtimeArn of ['', 'not-a-runtime-arn']) {
    expect(() => synth(runtimeArn, true, privateSubnets, { harnessEndpoint: 'https://harness.example/run', ...(harnessSigv4 === undefined ? {} : { harnessSigv4 }) }))
      .toThrow('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN');
  }
});

test.each([undefined, true])('a signed HTTPS Harness (%s) grants invocation of its deployed AgentCore runtime', harnessSigv4 => {
  const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime';
  const template = synth(runtimeArn, true, privateSubnets, { harnessEndpoint: 'https://harness.example/run', ...(harnessSigv4 === undefined ? {} : { harnessSigv4 }) });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
    { Name: 'AGENTCORE_RUNTIME_ARN', Value: runtimeArn },
    { Name: 'BOTCUBE_HARNESS_ENDPOINT', Value: 'https://harness.example/run' },
  ]) })]) });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
    Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow',
    Resource: [runtimeArn, `${runtimeArn}/runtime-endpoint/*`],
  }]) } });
});

test('an unsigned HTTPS Harness needs no AgentCore runtime ARN or invoke grant', () => {
  const template = synth('', true, privateSubnets, { harnessEndpoint: 'https://harness.example/run', harnessSigv4: false });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
    { Name: 'BOTCUBE_HARNESS_ENDPOINT', Value: 'https://harness.example/run' },
    { Name: 'BOTCUBE_HARNESS_SIGV4', Value: 'false' },
  ]) })]) });
  expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('bedrock-agentcore:InvokeAgentRuntime');
});

test('Chat Memory uses deployed identity, actor-leaf grants and one persistent Chat-only signing secret', () => {
  const template = synth();
  const secretId = Object.keys(template.findResources('AWS::SecretsManager::Secret')).find(id => id.includes('TurnMemorySecret'));
  assert(secretId);
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 64 },
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      Name: 'chat-service',
      Environment: Match.arrayWith([
        { Name: 'AGENTCORE_MEMORY_ID', Value: 'test_memory-AbCdEfGhIj' },
        { Name: 'BOTCUBE_TURN_MEMORY_URL', Value: 'https://api.example.com/internal/turn-memory' },
      ]),
      Secrets: [{ Name: 'BOTCUBE_TURN_MEMORY_SECRET', ValueFrom: { Ref: secretId } }],
    })]),
  });
  const [policy] = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.includes('ChatServiceTaskTaskRole'));
  assert(policy);
  const statements = policy[1].Properties.PolicyDocument.Statement;
  const memory = statements.filter((statement: { Action: string | string[] }) => [statement.Action].flat().some(action => /Memory|Event/.test(action)));
  expect(memory).toHaveLength(2);
  expect(memory).toEqual(expect.arrayContaining([expect.objectContaining({
    Action: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
    Condition: { StringLike: { 'bedrock-agentcore:namespacePath': '/strategies/*/actors/*/' } },
  })]));
  expect(JSON.stringify(memory)).toContain(':memory/test_memory-AbCdEfGhIj');
  expect(JSON.stringify(memory)).not.toContain('"/strategies/"');
  const grants = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([, resource]) => JSON.stringify(resource).includes('secretsmanager:GetSecretValue') && JSON.stringify(resource).includes(secretId));
  expect(grants).toHaveLength(1);
  expect(grants[0]?.[0]).toContain('ChatServiceTaskExecutionRole');
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


test('imported Memory ID survives Chat Service environment and actor-leaf IAM composition', () => {
  const template = synth(undefined, false, privateSubnets, { memoryId: Fn.importValue('AdopterMemoryId') });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'AGENTCORE_MEMORY_ID', Value: { 'Fn::ImportValue': 'AdopterMemoryId' } },
    ]) })]),
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
    Action: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
    Effect: 'Allow',
    Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-agentcore:us-east-1:123456789012:memory/', { 'Fn::ImportValue': 'AdopterMemoryId' }]] },
    Condition: { StringLike: { 'bedrock-agentcore:namespacePath': '/strategies/*/actors/*/' } },
  }]) } });
});

test.each([undefined, true])('imported runtime ARN survives signed Harness (%s) environment and invocation grants', harnessSigv4 => {
  const template = synth(Fn.importValue('AdopterRuntimeArn'), false, privateSubnets, {
    harnessEndpoint: 'https://harness.example/run', ...(harnessSigv4 === undefined ? {} : { harnessSigv4 }),
  });
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


test('imported Memory and parameter runtime compose together with the default AgentCore Harness', () => {
  const template = synth(undefined, false, privateSubnets, origin => ({
    memoryId: Fn.importValue('AdopterMemoryId'),
    runtimeArn: new CfnParameter(origin, 'AdopterRuntimeArn', { type: 'String' }).valueAsString,
  }));
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([
      { Name: 'AGENTCORE_RUNTIME_ARN', Value: { Ref: 'AdopterRuntimeArn' } },
      { Name: 'AGENTCORE_MEMORY_ID', Value: { 'Fn::ImportValue': 'AdopterMemoryId' } },
    ]) })]),
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
    Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow', Resource: [
      { Ref: 'AdopterRuntimeArn' }, { 'Fn::Join': ['', [{ Ref: 'AdopterRuntimeArn' }, '/runtime-endpoint/*']] },
    ],
  }]) } });
});

test.each(['', 'invalid', 'memory-with-hyphen-invalid', 'memory-invalid!'])('malformed concrete Memory ID %j is rejected', memoryId => {
  expect(() => synth(undefined, false, privateSubnets, { memoryId }))
    .toThrow('Chat Service requires the deployed AgentCore Memory ID');
});

test.each(['http://harness.example/run', 'https://user:password@harness.example/run', 'https://harness.example/run#fragment', Fn.importValue('AdopterHarnessEndpoint')])('Harness endpoint %j must remain concrete HTTPS without credentials or fragments', harnessEndpoint => {
  expect(() => synth(undefined, false, privateSubnets, { harnessEndpoint })).toThrow();
});


test('adopter names reach Chat tasks, roles, secrets, queues, ingress and alarms', () => {
  const template = synth(undefined, false, privateSubnets, {
    metricFilterNames: { sessionPurgeFailures: 'adopter-purge-filter', turnSummaryFailures: 'adopter-summary-filter', agentComputerStopSleepFailures: 'adopter-sleep-filter' },
    taskFamily: 'adopter-chat-task', reaperTaskFamily: 'adopter-reaper-task',
    taskRoleName: 'adopter-chat-role', executionRoleName: 'adopter-chat-execution',
    reaperTaskRoleName: 'adopter-reaper-role', reaperExecutionRoleName: 'adopter-reaper-execution',
    turnMemorySecretName: 'adopter-turn-secret', scheduledRunsQueueName: 'adopter-runs', scheduledRunsFailedQueueName: 'adopter-failed',
    scheduledRunsRoleName: 'adopter-scheduler', reaperInvocationRoleName: 'adopter-reaper-invoke',
    securityGroupName: 'adopter-chat-network', reaperSecurityGroupName: 'adopter-reaper-network',
    targetGroupName: 'adopter-chat-target', reaperRuleName: 'adopter-reaper-rule',
    alarmNames: { 'task-deficit': 'adopter-deficit', 'alb-5xx': 'adopter-alb-errors', 'session-purge-failures': 'adopter-purge-errors' },
  });
  for (const Family of ['adopter-chat-task', 'adopter-reaper-task']) template.hasResourceProperties('AWS::ECS::TaskDefinition', { Family });
  for (const RoleName of ['adopter-chat-role', 'adopter-chat-execution', 'adopter-reaper-role', 'adopter-reaper-execution', 'adopter-scheduler', 'adopter-reaper-invoke']) template.hasResourceProperties('AWS::IAM::Role', { RoleName });
  template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'adopter-turn-secret' });
  for (const QueueName of ['adopter-runs', 'adopter-failed']) template.hasResourceProperties('AWS::SQS::Queue', { QueueName });
  for (const GroupName of ['adopter-chat-network', 'adopter-reaper-network']) template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Name: 'adopter-chat-target' });
  template.hasResourceProperties('AWS::Events::Rule', { Name: 'adopter-reaper-rule' });
  for (const AlarmName of ['adopter-deficit', 'adopter-alb-errors', 'adopter-purge-errors']) template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName });
  for (const FilterName of ['adopter-purge-filter', 'adopter-summary-filter', 'adopter-sleep-filter']) template.hasResourceProperties('AWS::Logs::MetricFilter', { FilterName });
  expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))).toEqual(['OriginHttpsChatServiceGroup7CF46779']);
});

test('adopter Chat secret and scheduled queue are consumed without replacement', () => {
  const template = synth(undefined, false, privateSubnets, origin => ({
    turnMemorySecret: secretsmanager.Secret.fromSecretCompleteArn(origin, 'OwnedSecret', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:owned-turn-secret-ABCDEF'),
    scheduledRunsQueue: sqs.Queue.fromQueueArn(origin, 'OwnedQueue', 'arn:aws:sqs:us-east-1:123456789012:owned-runs'),
  }));
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      Secrets: Match.arrayWith([{ Name: 'BOTCUBE_TURN_MEMORY_SECRET', ValueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:owned-turn-secret-ABCDEF' }]),
      Environment: Match.arrayWith([{ Name: 'BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', Value: 'arn:aws:sqs:us-east-1:123456789012:owned-runs' }]),
    })]),
  });
});

test('imported Chat resources own their names and queue redrive settings', () => {
  expect(() => synth(undefined, false, privateSubnets, origin => ({
    executionRole: iam.Role.fromRoleArn(origin, 'OwnedRole', 'arn:aws:iam::123456789012:role/owned-execution', { mutable: false }), executionRoleName: 'replacement',
  }))).toThrow('imported executionRole owns its name');
  expect(() => synth(undefined, false, privateSubnets, origin => ({
    turnMemorySecret: secretsmanager.Secret.fromSecretCompleteArn(origin, 'OwnedSecret', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:owned-turn-secret-ABCDEF'), turnMemorySecretName: 'replacement',
  }))).toThrow('imported turnMemorySecret owns its name');
  expect(() => synth(undefined, false, privateSubnets, origin => ({
    scheduledRunsQueue: sqs.Queue.fromQueueArn(origin, 'OwnedQueue', 'arn:aws:sqs:us-east-1:123456789012:owned-runs'), scheduledRunsFailedQueueName: 'replacement',
  }))).toThrow('imported scheduledRunsQueue owns its name and redrive settings');
});
