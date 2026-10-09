import { optionalPhysicalName } from './physical-name.js';
import { ArnFormat, CfnOutput, Duration, Stack, Token } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { nameTaskRoles } from './task-role-names.js';
import { PreviewOriginStack } from './preview-origin-stack.js';

/** Adopters reserve these listener priorities and own all shared ALB attributes. */
export interface ChatServiceIngress {
  securityGroup: ec2.ISecurityGroup;
  loadBalancer: elb.IApplicationLoadBalancer;
  listener: elb.IApplicationListener;
  cdpRulePriority: number;
  chatRulePriority: number;
}

export interface PreviewChatServiceProps {
  /** Additional Cartridge configuration; framework-owned environment keys take precedence. */
  environment?: Record<string, string>;
  turnMemorySecret?: secretsmanager.ISecret;
  scheduledRunsQueue?: sqs.IQueue;
  metricFilterNames?: Partial<Record<'sessionPurgeFailures' | 'turnSummaryFailures' | 'agentComputerStopSleepFailures', string>>;
  taskFamily?: string;
  reaperTaskFamily?: string;
  taskRoleName?: string;
  executionRoleName?: string;
  reaperTaskRoleName?: string;
  reaperExecutionRoleName?: string;
  turnMemorySecretName?: string;
  scheduledRunsQueueName?: string;
  scheduledRunsFailedQueueName?: string;
  scheduledRunsRoleName?: string;
  reaperInvocationRoleName?: string;
  securityGroupName?: string;
  reaperSecurityGroupName?: string;
  targetGroupName?: string;
  reaperRuleName?: string;
  alarmNames?: Partial<Record<'task-deficit' | 'session-purge-failures' | 'turn-summary-failures' | 'agent-computer-stop-sleep-failures' | 'alb-5xx' | 'target-5xx' | 'unhealthy-hosts', string>>;
  ingress?: ChatServiceIngress;
  vpc?: ec2.IVpc;
  subnets?: ec2.SubnetSelection;
  securityGroups?: ec2.ISecurityGroup[];
  executionRole?: iam.IRole;
  permissionsBoundary?: iam.IManagedPolicy;
  desiredCount?: number;
  minHealthyPercent?: number;
  maxHealthyPercent?: number;
  healthGraceSeconds?: number;
  healthIntervalSeconds?: number;
  healthTimeoutSeconds?: number;
  healthHealthyThreshold?: number;
  healthUnhealthyThreshold?: number;
  /** Provided-origin idle timeout; adopters configure shared ALB attributes themselves. */
  loadBalancerIdleSeconds?: number;
  alarmPeriodSeconds?: number;
  alarmEvaluationPeriods?: number;
  failureAlarmPeriodSeconds?: number;
  reaperRetryAttempts?: number;
  reaperMaxEventAgeSeconds?: number;
  cpu?: number;
  memoryLimitMiB?: number;
  port?: number;
  serviceName?: string;
  logGroupName?: string;
  logStreamPrefix?: string;
  scheduleGroupName?: string;
  reaperLogGroupName?: string;
  reaperLogStreamPrefix?: string;
  logRetention?: logs.RetentionDays;
  reaperCpu?: number;
  reaperMemoryLimitMiB?: number;
  reaperSchedule?: string;
  reaperLogRetention?: logs.RetentionDays;
  containerStopTimeoutSeconds?: number;
  scheduledRunVisibilitySeconds?: number;
  scheduledRunRetentionDays?: number;
  scheduledRunMaxReceiveCount?: number;
  drainSeconds?: number;
  browserId?: string;
  harnessEndpoint?: string;
  harnessSigv4?: boolean;
  vpcId: string;
  privateSubnets: { id: string; availabilityZone: string }[];
  clusterName: string;
  alertsTopicName: string;
  hostnames: string[];
  corsOrigins: string[];
  runtimeArn?: string;
  memoryId: string;
  /** The session API function the AgentCore stack deploys (ADR 0067 §5). */
  sessionApiFunctionName: string;
  /** The session API alias the AgentCore stack keeps initialized. */
  sessionApiAlias: string;
  chatTable: dynamodb.ITable;
  image: ecs.ContainerImage;
  /** The auth-browser reaper's command, run in the Chat Service image. */
  reaperCommand: string[];
  authBrowserId: string;
  /** Parked runs no tasks and has no ALB; the target group stays so park can cut its streams. */
  parked: boolean;
}

function validateChatService(props: PreviewChatServiceProps): void {
  if (props.turnMemorySecret && props.turnMemorySecretName !== undefined) throw new Error('An imported turnMemorySecret owns its name; omit turnMemorySecretName');
  if (props.scheduledRunsQueue && [props.scheduledRunsQueueName, props.scheduledRunsFailedQueueName, props.scheduledRunVisibilitySeconds, props.scheduledRunRetentionDays, props.scheduledRunMaxReceiveCount].some(value => value !== undefined)) throw new Error('An imported scheduledRunsQueue owns its name and redrive settings; omit queue creation options');
  if (!Token.isUnresolved(props.memoryId) && !/^[A-Za-z0-9_]+-[A-Za-z0-9]+$/.test(props.memoryId)) throw new Error('Chat Service requires the deployed AgentCore Memory ID');
  if ((!props.vpc && !props.subnets && props.privateSubnets.length < 2) || ((!props.harnessEndpoint || props.harnessSigv4 !== false) && !Token.isUnresolved(props.runtimeArn) && !/^arn:aws:bedrock-agentcore:[^:]+:\d{12}:runtime\/.+$/.test(props.runtimeArn ?? ''))) {
    throw new Error('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN');
  }
  if (props.harnessEndpoint) {
    const endpoint = new URL(props.harnessEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Harness endpoint must be HTTPS without credentials or fragment');
  }
}

/** Deploy the Chat Service with the provided origin or adopter-owned ingress. */
export class PreviewChatService extends Construct {
  readonly cluster: ecs.Cluster;
  readonly network: ec2.SecurityGroup;
  readonly task: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;
  readonly service: ecs.FargateService;
  constructor(scope: Construct, id: string, props: PreviewChatServiceProps) {
    super(scope, id);
    const origin = Stack.of(this);
    const { providedOrigin, ingressResources, outputScope, alb } = resolveIngress(scope, this, props);
    validateChatService(props);
    if (props.permissionsBoundary) iam.PermissionsBoundary.of(this).apply(props.permissionsBoundary);
    const port = props.port ?? 8123;
    const vpc = props.vpc ?? ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: props.vpcId,
      availabilityZones: props.privateSubnets.map(subnet => subnet.availabilityZone),
      privateSubnetIds: props.privateSubnets.map(subnet => subnet.id),
    });
    const selectedSubnets = props.subnets || props.vpc
      ? vpc.selectSubnets(props.subnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds
      : props.privateSubnets.map(subnet => subnet.id);
    if (selectedSubnets.length === 0) throw new Error('Preview Chat Service requires a non-empty private subnet selection');
    const cluster = this.cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: props.clusterName, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const ingress = this.network = new ec2.SecurityGroup(this, 'Ingress', { vpc, ...optionalPhysicalName('securityGroupName', props.securityGroupName) });
    allowIngress(ingress, ingressResources.securityGroup, port, Boolean(props.ingress));
    const task = this.task = new ecs.FargateTaskDefinition(this, 'Task', {
      ...optionalPhysicalName('family', props.taskFamily),
      cpu: props.cpu ?? 512, memoryLimitMiB: props.memoryLimitMiB ?? 1024,
      ...(props.executionRole ? { executionRole: props.executionRole } : {}),
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    nameTaskRoles(task, props.taskRoleName, props.executionRoleName, props.executionRole);
    props.chatTable.grantReadWriteData(task.taskRole);
    if (props.runtimeArn) task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.runtimeArn, `${props.runtimeArn}/runtime-endpoint/*`],
    }));
    if (props.runtimeArn) task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:StopRuntimeSession'],
      resources: [props.runtimeArn, `${props.runtimeArn}/runtime-endpoint/*`],
    }));
    const memoryArn = origin.formatArn({ service: 'bedrock-agentcore', resource: 'memory', resourceName: props.memoryId });
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetMemory', 'bedrock-agentcore:ListEvents', 'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:CreateEvent', 'bedrock-agentcore:DeleteEvent', 'bedrock-agentcore:GetMemoryRecord',
        'bedrock-agentcore:DeleteMemoryRecord', 'bedrock-agentcore:BatchUpdateMemoryRecords'],
      resources: [memoryArn],
    }));
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
      resources: [memoryArn],
      conditions: { StringLike: { 'bedrock-agentcore:namespacePath': '/strategies/*/actors/*/' } },
    }));
    const turnMemorySecret = props.turnMemorySecret ?? new secretsmanager.Secret(this, 'TurnMemorySecret', {
      ...optionalPhysicalName('secretName', props.turnMemorySecretName),
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    // The session API has no public endpoint; this grant is its only caller.
    const sessionApiFunctionArn = origin.formatArn({
      service: 'lambda', resource: 'function', resourceName: props.sessionApiFunctionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const sessionApiArn = `${sessionApiFunctionArn}:${props.sessionApiAlias}`;
    // Old tasks still call the unqualified function while the ALB drains their streams.
    task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [sessionApiFunctionArn, sessionApiArn] }));
    const browserId = props.browserId ?? 'aws.browser.v1';
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ConnectBrowserLiveViewStream'],
      resources: [browserLiveViewArn(origin, browserId)],
    }));
    // Read-only and limited to this cluster's tasks: each task describes itself, so a deploy's draining task stops taking scheduled runs.
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'],
      resources: [origin.formatArn({ service: 'ecs', resource: 'task', resourceName: `${props.clusterName}/*` })],
      conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
    }));
    const logGroup = new logs.LogGroup(this, 'Logs', { logGroupName: props.logGroupName ?? `/${props.clusterName}/chat-service-preview`, retention: props.logRetention ?? logs.RetentionDays.ONE_WEEK });
    this.container = task.addContainer('chat-service', {
      image: props.image,
      portMappings: [{ containerPort: port }],
      environment: {
        ...props.environment,
        AWS_DEFAULT_REGION: origin.region,
        AGENTCORE_REGION: origin.region,
        ...(props.runtimeArn ? { AGENTCORE_RUNTIME_ARN: props.runtimeArn } : {}),
        AGENTCORE_MEMORY_ID: props.memoryId,
        BOTCUBE_TURN_MEMORY_URL: `https://${props.hostnames.at(-1)}/internal/turn-memory`,
        BOTCUBE_SESSION_API_FUNCTION_ARN: sessionApiArn,
        AGENTCORE_BROWSER_ID: browserId,
        BOTCUBE_CHAT_TABLE: props.chatTable.tableName,
        BOTCUBE_CORS_ORIGINS: props.corsOrigins.join(','),
        ...(props.harnessEndpoint ? { BOTCUBE_HARNESS_ENDPOINT: props.harnessEndpoint } : {}),
        ...(props.harnessSigv4 !== undefined ? { BOTCUBE_HARNESS_SIGV4: String(props.harnessSigv4) } : {}),
        PORT: String(port),
      },
      secrets: { BOTCUBE_TURN_MEMORY_SECRET: ecs.Secret.fromSecretsManager(turnMemorySecret as secretsmanager.ISecret) },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.logStreamPrefix ?? 'chat-service', logGroup }),
      // Allow task-stop cleanup before ECS sends SIGKILL.
      stopTimeout: Duration.seconds(props.containerStopTimeoutSeconds ?? 120),
    });
    // Scheduled tasks: each task's schedule sends its run to a queue the Chat Service polls,
    // since EventBridge Scheduler cannot call the Chat Service directly.
    const scheduleGroup = props.scheduleGroupName ?? `${props.clusterName}-scheduled-tasks`;
    new scheduler.CfnScheduleGroup(this, 'ScheduledTasks', { name: scheduleGroup });
    const runs = props.scheduledRunsQueue ?? new sqs.Queue(this, 'ScheduledRuns', {
      ...optionalPhysicalName('queueName', props.scheduledRunsQueueName),
      // Longer than a run's stream, so a run in progress is not delivered twice.
      visibilityTimeout: Duration.seconds(props.scheduledRunVisibilitySeconds ?? 900),
      deadLetterQueue: { queue: new sqs.Queue(this, 'ScheduledRunsFailed', { ...optionalPhysicalName('queueName', props.scheduledRunsFailedQueueName), retentionPeriod: Duration.days(props.scheduledRunRetentionDays ?? 14) }), maxReceiveCount: props.scheduledRunMaxReceiveCount ?? 3 },
    });
    const runsRole = new iam.Role(this, 'ScheduledRunsRole', { ...optionalPhysicalName('roleName', props.scheduledRunsRoleName), assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    runs.grantSendMessages(runsRole);
    runs.grantConsumeMessages(task.taskRole);
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
      resources: [origin.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${scheduleGroup}/*` })],
    }));
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['scheduler:GetScheduleGroup'],
      resources: [origin.formatArn({ service: 'scheduler', resource: 'schedule-group', resourceName: scheduleGroup })],
    }));
    runsRole.grantPassRole(task.taskRole);
    this.container.addEnvironment('BOTCUBE_SCHEDULE_GROUP', scheduleGroup);
    this.container.addEnvironment('BOTCUBE_SCHEDULER_ROLE_ARN', runsRole.roleArn);
    this.container.addEnvironment('BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', runs.queueArn);
    this.container.addEnvironment('BOTCUBE_SCHEDULED_RUNS_QUEUE_URL', runs.queueUrl);
    // Reuse the Chat Service image; the reaper runs its reap command against the login browser.
    // The reaper needs no serving-role table/runtime permissions.
    const reaper = new ecs.FargateTaskDefinition(this, 'ReaperTask', {
      ...optionalPhysicalName('family', props.reaperTaskFamily),
      cpu: props.reaperCpu ?? 256, memoryLimitMiB: props.reaperMemoryLimitMiB ?? 512,
      ...(props.executionRole ? { executionRole: props.executionRole } : {}),
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    nameTaskRoles(reaper, props.reaperTaskRoleName, props.reaperExecutionRoleName, props.executionRole);
    const reaperBrowserId = props.authBrowserId;
    const reaperBrowserArn = origin.formatArn({
      service: 'bedrock-agentcore',
      resource: 'browser-custom', resourceName: reaperBrowserId,
    });
    reaper.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ListBrowserSessions', 'bedrock-agentcore:StopBrowserSession'],
      resources: [reaperBrowserArn],
    }));
    const reaperLogs = new logs.LogGroup(this, 'ReaperLogs', {
      logGroupName: props.reaperLogGroupName ?? `/${props.clusterName}/auth-browser-reaper-preview`, retention: props.reaperLogRetention ?? logs.RetentionDays.ONE_WEEK,
    });
    reaper.addContainer('reaper', {
      image: props.image, command: props.reaperCommand,
      environment: { AWS_DEFAULT_REGION: origin.region, AGENTCORE_REGION: origin.region, AGENTCORE_BROWSER_ID: reaperBrowserId },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.reaperLogStreamPrefix ?? 'reaper', logGroup: reaperLogs }),
    });
    const reaperNetwork = new ec2.SecurityGroup(this, 'ReaperNetwork', { vpc, ...optionalPhysicalName('securityGroupName', props.reaperSecurityGroupName) });
    const schedulerRole = new iam.Role(this, 'ReaperInvocationRole', {
      ...optionalPhysicalName('roleName', props.reaperInvocationRoleName),
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'], resources: [reaper.taskDefinitionArn],
      conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
    }));
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [reaper.taskRole.roleArn, reaper.obtainExecutionRole().roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    const reaperSchedule = new events.CfnRule(this, 'ReaperSchedule', {
      ...optionalPhysicalName('name', props.reaperRuleName),
      scheduleExpression: props.reaperSchedule ?? 'rate(5 minutes)', state: props.parked ? 'DISABLED' : 'ENABLED',
      description: 'Expire abandoned credential login browser sessions',
      targets: [{
        id: 'Reaper', arn: cluster.clusterArn, roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: props.reaperRetryAttempts ?? 0, maximumEventAgeInSeconds: props.reaperMaxEventAgeSeconds ?? 60 },
        ecsParameters: {
          taskDefinitionArn: reaper.taskDefinitionArn, launchType: 'FARGATE', taskCount: 1,
          networkConfiguration: { awsVpcConfiguration: {
            assignPublicIp: 'DISABLED', subnets: selectedSubnets,
            securityGroups: [reaperNetwork.securityGroupId],
          } },
        },
      }],
    });
    new CfnOutput(outputScope, 'ReaperBrowserId', { value: reaperBrowserId });
    new CfnOutput(outputScope, 'ReaperTaskDefinitionArn', { value: reaper.taskDefinitionArn });
    new CfnOutput(outputScope, 'ReaperRuleName', { value: reaperSchedule.ref });
    new CfnOutput(outputScope, 'ReaperLogGroupName', { value: reaperLogs.logGroupName });
    new CfnOutput(outputScope, 'ReaperSecurityGroupId', { value: reaperNetwork.securityGroupId });
    const service = this.service = new ecs.FargateService(this, 'Service', {
      // aws-cdk-lib's Cluster declares `T | undefined` getters where ICluster declares `prop?: T`,
      // which exactOptionalPropertyTypes rejects; the construct is its interface.
      cluster: cluster as ecs.ICluster, taskDefinition: task, serviceName: props.serviceName ?? 'chat-service-preview', desiredCount: props.parked ? 0 : (props.desiredCount ?? 1),
      ...(props.subnets ? { vpcSubnets: props.subnets } : {}),
      assignPublicIp: false,
      securityGroups: [ingress, ...(props.securityGroups ?? [])], minHealthyPercent: props.minHealthyPercent ?? 100, maxHealthyPercent: props.maxHealthyPercent ?? 200,
      circuitBreaker: { rollback: true }, healthCheckGracePeriod: Duration.seconds(props.healthGraceSeconds ?? 60),
    });
    const topic = sns.Topic.fromTopicArn(this, 'Alerts', origin.formatArn({ service: 'sns', resource: props.alertsTopicName }));
    const period = Duration.seconds(props.alarmPeriodSeconds ?? 60);
    const taskMetric = (metricName: string) => new cloudwatch.Metric({
      namespace: 'ECS/ContainerInsights', metricName,
      dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: service.serviceName },
      period,
    });
    // Availability alarms (the `-preview-` set the Smoke Test checks) by default.
    const alarm = (suffix: keyof NonNullable<PreviewChatServiceProps['alarmNames']>, metric: cloudwatch.IMetric, missing: cloudwatch.TreatMissingData, threshold = 0, comparisonOperator = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      { periods = props.alarmEvaluationPeriods ?? 3, alarmName = `${props.clusterName}-preview-${suffix}`, silenceWhenParked = true } = {}) => {
      const value = new cloudwatch.Alarm(this, suffix, {
        alarmName: props.alarmNames?.[suffix] ?? alarmName, metric, threshold,
        comparisonOperator,
        evaluationPeriods: periods, datapointsToAlarm: periods, treatMissingData: missing,
        // Parked runs zero tasks on purpose: silence rather than page (production-parking.md).
        ...(silenceWhenParked ? { actionsEnabled: !props.parked } : {}),
      });
      value.addAlarmAction(new actions.SnsAction(topic));
      value.addOkAction(new actions.SnsAction(topic));
    };
    // Ratio makes missing desired telemetry a dropped point (division by zero),
    // so it breaches rather than looking like a healthy negative deficit.
    alarm('task-deficit', new cloudwatch.MathExpression({
      expression: 'running / desired', usingMetrics: { running: taskMetric('RunningTaskCount'), desired: taskMetric('DesiredTaskCount') }, period,
    }), cloudwatch.TreatMissingData.BREACHING, 1, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    // A purge whose retries ran out leaves the Session fenced with its events stored.
    const purgeFailures = new logs.MetricFilter(this, 'SessionPurgeFailures', {
      ...optionalPhysicalName('filterName', props.metricFilterNames?.sessionPurgeFailures),
      logGroup, filterPattern: logs.FilterPattern.literal('"Session purge failed"'),
      metricNamespace: 'BotCube/ChatService', metricName: 'SessionPurgeFailures', metricValue: '1',
    });
    alarm('session-purge-failures', purgeFailures.metric({ statistic: 'Sum', period: Duration.seconds(props.failureAlarmPeriodSeconds ?? 300) }), cloudwatch.TreatMissingData.NOT_BREACHING, 0, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // It counts logged failures, so it cannot breach at zero tasks and keeps its actions while Parked.
      { periods: 1, alarmName: `${props.clusterName}-session-purge-failures`, silenceWhenParked: false });
    // A failed Turn summary leaves that Turn's Activity row showing the request's first line.
    const summaryFailures = new logs.MetricFilter(this, 'TurnSummaryFailures', {
      ...optionalPhysicalName('filterName', props.metricFilterNames?.turnSummaryFailures),
      logGroup, filterPattern: logs.FilterPattern.literal('"Turn summary failed"'),
      metricNamespace: 'BotCube/ChatService', metricName: 'TurnSummaryFailures', metricValue: '1',
    });
    alarm('turn-summary-failures', summaryFailures.metric({ statistic: 'Sum', period: Duration.seconds(props.failureAlarmPeriodSeconds ?? 300) }), cloudwatch.TreatMissingData.NOT_BREACHING, 0, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      { periods: 1, alarmName: `${props.clusterName}-turn-summary-failures`, silenceWhenParked: false });
    // A stopping task whose Agent Computer browsers did not sleep may leave them running until their timeout.
    const stopSleepFailures = new logs.MetricFilter(this, 'AgentComputerStopSleepFailures', {
      ...optionalPhysicalName('filterName', props.metricFilterNames?.agentComputerStopSleepFailures),
      logGroup, filterPattern: logs.FilterPattern.literal('"Agent Computer sleep at task stop failed"'),
      metricNamespace: 'BotCube/ChatService', metricName: 'AgentComputerStopSleepFailures', metricValue: '1',
    });
    alarm('agent-computer-stop-sleep-failures', stopSleepFailures.metric({ statistic: 'Sum', period: Duration.seconds(props.failureAlarmPeriodSeconds ?? 300) }), cloudwatch.TreatMissingData.NOT_BREACHING, 0, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      { periods: 1, alarmName: `${props.clusterName}-agent-computer-stop-sleep-failures`, silenceWhenParked: false });
    new CfnOutput(outputScope, 'AlertsTopicArn', { value: topic.topicArn });
    new CfnOutput(outputScope, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(outputScope, 'ServiceName', { value: service.serviceName });
    new CfnOutput(outputScope, 'TaskDefinitionArn', { value: task.taskDefinitionArn });
    new CfnOutput(outputScope, 'ChatTableName', { value: props.chatTable.tableName });
    // Live drains a stream for up to an hour so a deploy doesn't cut it. Park proceeds
    // immediately instead: the dependency updates the group to no delay before the
    // service scales to 0, and the group survives Parked (it costs nothing) so that
    // update happens in place rather than in the cleanup after the service.
    const target = new elb.ApplicationTargetGroup(this, 'Target', {
      ...optionalPhysicalName('targetGroupName', props.targetGroupName),
      vpc, port, protocol: elb.ApplicationProtocol.HTTP, targetType: elb.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(props.healthIntervalSeconds ?? 5), timeout: Duration.seconds(props.healthTimeoutSeconds ?? 4), healthyThresholdCount: props.healthHealthyThreshold ?? 2, unhealthyThresholdCount: props.healthUnhealthyThreshold ?? 6 },
      deregistrationDelay: Duration.seconds(props.parked ? 0 : (props.drainSeconds ?? 3600)),
    });
    preserveTarget(service, target, providedOrigin);
    // The origin has an ALB only while Live.
    if (!alb) {
      // An empty list removes the association in place; omitting it would keep the old one.
      (service.node.defaultChild as ecs.CfnService).loadBalancers = [];
      return;
    }
    attachIngress(this, service, target, props, alb, providedOrigin);
    addIngressAlarms(alarm, target, alb.loadBalancer, period, providedOrigin !== undefined);
    new CfnOutput(outputScope, 'TargetGroupArn', { value: target.targetGroupArn });
  }
}

/** Target alarms belong to this service; ALB errors belong only to the provided origin. */
function addIngressAlarms(
  alarm: (suffix: 'alb-5xx' | 'target-5xx' | 'unhealthy-hosts', metric: cloudwatch.IMetric, missing: cloudwatch.TreatMissingData) => void,
  target: elb.ApplicationTargetGroup,
  loadBalancer: elb.IApplicationLoadBalancer,
  period: Duration,
  ownsOrigin: boolean,
): void {
  if (ownsOrigin) alarm('alb-5xx', loadBalancer.metrics.httpCodeElb(elb.HttpCodeElb.ELB_5XX_COUNT, { statistic: 'Sum', period }), cloudwatch.TreatMissingData.NOT_BREACHING);
  alarm('target-5xx', target.metrics.httpCodeTarget(elb.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum', period }), cloudwatch.TreatMissingData.NOT_BREACHING);
  alarm('unhealthy-hosts', target.metrics.unhealthyHostCount({ statistic: 'Minimum', period }), cloudwatch.TreatMissingData.NOT_BREACHING);
}

function browserLiveViewArn(origin: Stack, browserId: string): string {
  return origin.formatArn({ service: 'bedrock-agentcore', ...(browserId === 'aws.browser.v1' ? { account: 'aws', resource: 'browser' } : { resource: 'browser-custom' }), resourceName: browserId });
}

function resolveIngress(scope: Construct, chat: Construct, props: PreviewChatServiceProps) {
  const providedOrigin = scope instanceof PreviewOriginStack && !props.ingress ? scope : undefined;
  const ingressResources = props.ingress ?? providedOrigin;
  if (!ingressResources) throw new Error('Chat Service requires adopter ingress or a provided PreviewOriginStack');
  if (props.ingress) {
    const { cdpRulePriority, chatRulePriority } = props.ingress;
    if (![cdpRulePriority, chatRulePriority].every(priority => Number.isInteger(priority) && priority >= 1 && priority <= 50000) || cdpRulePriority >= chatRulePriority) {
      throw new Error('Chat Service ingress requires distinct listener priorities from 1 to 50000, with CDP before Chat');
    }
    if (props.loadBalancerIdleSeconds !== undefined) throw new Error('Adopter owns shared ALB idle timeout; configure it on the ALB');
  }
  return { providedOrigin, ingressResources, outputScope: providedOrigin ?? chat, alb: props.ingress ?? providedOrigin?.alb };
}

function attachIngress(scope: Construct, service: ecs.FargateService, target: elb.ApplicationTargetGroup, props: PreviewChatServiceProps, alb: { loadBalancer: elb.IApplicationLoadBalancer; listener: elb.IApplicationListener }, providedOrigin: PreviewOriginStack | undefined): void {
  // CDK automatically grants ALB egress when a service registers as a listener target.
  // Import an immutable view so only the Chat Service's ingress can be changed.
  const listener = props.ingress ? elb.ApplicationListener.fromApplicationListenerAttributes(scope, 'AdopterListener', {
    listenerArn: props.ingress.listener.listenerArn,
    securityGroup: ec2.SecurityGroup.fromSecurityGroupId(scope, 'AdopterIngress', props.ingress.securityGroup.securityGroupId, { mutable: false }),
  }) : alb.listener;
  if (providedOrigin?.alb) providedOrigin.alb.loadBalancer.setAttribute('idle_timeout.timeout_seconds', String(props.loadBalancerIdleSeconds ?? 3600));
  service.attachToApplicationTargetGroup(target);
  // The Agent Computer CDP channel is for the harness only, which reaches it over
  // Cloud Map; the public listener answers it 404 before forwarding anything.
  // Priorities 5 and 10 never collide with the forward rule's former 1 mid-update.
  if (props.ingress) {
    new elb.ApplicationListenerRule(scope, 'AgentComputerCdp', {
      listener, priority: props.ingress.cdpRulePriority,
      conditions: [elb.ListenerCondition.hostHeaders(props.hostnames), elb.ListenerCondition.pathPatterns(['/agent-computer/cdp*'])],
      action: elb.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found\n' }),
    });
    new elb.ApplicationListenerRule(scope, 'ChatService', {
      listener, priority: props.ingress.chatRulePriority,
      conditions: [elb.ListenerCondition.hostHeaders(props.hostnames)], targetGroups: [target],
    });
  } else {
    listener.addAction('AgentComputerCdp', {
      priority: 5, conditions: [elb.ListenerCondition.pathPatterns(['/agent-computer/cdp*'])],
      action: elb.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found\n' }),
    });
    listener.addTargetGroups('ChatService', {
      priority: 10, conditions: [elb.ListenerCondition.hostHeaders(props.hostnames)], targetGroups: [target],
    });
  }
}

function allowIngress(network: ec2.SecurityGroup, ingress: ec2.ISecurityGroup, port: number, adopterOwned: boolean): void {
  if (adopterOwned) network.addIngressRule(ec2.Peer.securityGroupId(ingress.securityGroupId), ec2.Port.tcp(port), 'Preview ALB only');
  else network.connections.allowFrom(ingress, ec2.Port.tcp(port), 'Preview ALB only');
}

function preserveTarget(service: ecs.FargateService, target: elb.ApplicationTargetGroup, providedOrigin: PreviewOriginStack | undefined): void {
  // Preserve the provided origin's former listener target instead of replacing it.
  if (providedOrigin) (target.node.defaultChild as elb.CfnTargetGroup).overrideLogicalId('OriginHttpsChatServiceGroup7CF46779');
  service.node.addDependency(target);
}
