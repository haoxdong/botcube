import { ArnFormat, CfnOutput, Duration } from 'aws-cdk-lib';
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
import { PreviewOriginStack } from './preview-origin-stack.js';

export interface PreviewChatServiceProps {
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
  if (!/^[A-Za-z0-9_]+-[A-Za-z0-9]+$/.test(props.memoryId)) throw new Error('Chat Service requires the deployed AgentCore Memory ID');
  if ((!props.vpc && !props.subnets && props.privateSubnets.length < 2) || ((!props.harnessEndpoint || props.harnessSigv4 !== false) && !/^arn:aws:bedrock-agentcore:[^:]+:\d{12}:runtime\/.+$/.test(props.runtimeArn ?? ''))) {
    throw new Error('Preview Chat Service requires private subnets and the deployed AgentCore runtime ARN');
  }
  if (props.harnessEndpoint) {
    const endpoint = new URL(props.harnessEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Harness endpoint must be HTTPS without credentials or fragment');
  }
}

/** The preview shares the existing origin's deployment owner and TLS boundary. */
export class PreviewChatService extends Construct {
  readonly cluster: ecs.Cluster;
  readonly network: ec2.SecurityGroup;
  readonly task: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;
  readonly service: ecs.FargateService;
  constructor(origin: PreviewOriginStack, id: string, props: PreviewChatServiceProps) {
    super(origin, id);
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
    const ingress = this.network = new ec2.SecurityGroup(this, 'Ingress', { vpc });
    ingress.connections.allowFrom(origin.securityGroup, ec2.Port.tcp(port), 'Preview ALB only');
    const task = this.task = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.cpu ?? 512, memoryLimitMiB: props.memoryLimitMiB ?? 1024,
      ...(props.executionRole ? { executionRole: props.executionRole } : {}),
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    props.chatTable.grantReadWriteData(task.taskRole);
    if (props.runtimeArn) task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
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
    const turnMemorySecret = new secretsmanager.Secret(this, 'TurnMemorySecret', {
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
        ...(props.port !== undefined ? { PORT: String(port) } : {}),
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
    const runs = new sqs.Queue(this, 'ScheduledRuns', {
      // Longer than a run's stream, so a run in progress is not delivered twice.
      visibilityTimeout: Duration.seconds(props.scheduledRunVisibilitySeconds ?? 900),
      deadLetterQueue: { queue: new sqs.Queue(this, 'ScheduledRunsFailed', { retentionPeriod: Duration.days(props.scheduledRunRetentionDays ?? 14) }), maxReceiveCount: props.scheduledRunMaxReceiveCount ?? 3 },
    });
    const runsRole = new iam.Role(this, 'ScheduledRunsRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    runs.grantSendMessages(runsRole);
    runs.grantConsumeMessages(task.taskRole);
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
      resources: [origin.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${scheduleGroup}/*` })],
    }));
    runsRole.grantPassRole(task.taskRole);
    this.container.addEnvironment('BOTCUBE_SCHEDULE_GROUP', scheduleGroup);
    this.container.addEnvironment('BOTCUBE_SCHEDULER_ROLE_ARN', runsRole.roleArn);
    this.container.addEnvironment('BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', runs.queueArn);
    this.container.addEnvironment('BOTCUBE_SCHEDULED_RUNS_QUEUE_URL', runs.queueUrl);
    // Reuse the Chat Service image; the reaper runs its reap command against the login browser.
    // The reaper needs no serving-role table/runtime permissions.
    const reaper = new ecs.FargateTaskDefinition(this, 'ReaperTask', {
      cpu: props.reaperCpu ?? 256, memoryLimitMiB: props.reaperMemoryLimitMiB ?? 512,
      ...(props.executionRole ? { executionRole: props.executionRole } : {}),
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
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
    const reaperNetwork = new ec2.SecurityGroup(this, 'ReaperNetwork', { vpc });
    const schedulerRole = new iam.Role(this, 'ReaperInvocationRole', {
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
    new CfnOutput(origin, 'ReaperBrowserId', { value: reaperBrowserId });
    new CfnOutput(origin, 'ReaperTaskDefinitionArn', { value: reaper.taskDefinitionArn });
    new CfnOutput(origin, 'ReaperRuleName', { value: reaperSchedule.ref });
    new CfnOutput(origin, 'ReaperLogGroupName', { value: reaperLogs.logGroupName });
    new CfnOutput(origin, 'ReaperSecurityGroupId', { value: reaperNetwork.securityGroupId });
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
    const alarm = (suffix: string, metric: cloudwatch.IMetric, missing: cloudwatch.TreatMissingData, threshold = 0, comparisonOperator = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      { periods = props.alarmEvaluationPeriods ?? 3, alarmName = `${props.clusterName}-preview-${suffix}`, silenceWhenParked = true } = {}) => {
      const value = new cloudwatch.Alarm(this, suffix, {
        alarmName, metric, threshold,
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
      logGroup, filterPattern: logs.FilterPattern.literal('"Session purge failed"'),
      metricNamespace: 'BotCube/ChatService', metricName: 'SessionPurgeFailures', metricValue: '1',
    });
    alarm('session-purge-failures', purgeFailures.metric({ statistic: 'Sum', period: Duration.seconds(props.failureAlarmPeriodSeconds ?? 300) }), cloudwatch.TreatMissingData.NOT_BREACHING, 0, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // It counts logged failures, so it cannot breach at zero tasks and keeps its actions while Parked.
      { periods: 1, alarmName: `${props.clusterName}-session-purge-failures`, silenceWhenParked: false });
    // A failed Turn summary leaves that Turn's Activity row showing the request's first line.
    const summaryFailures = new logs.MetricFilter(this, 'TurnSummaryFailures', {
      logGroup, filterPattern: logs.FilterPattern.literal('"Turn summary failed"'),
      metricNamespace: 'BotCube/ChatService', metricName: 'TurnSummaryFailures', metricValue: '1',
    });
    alarm('turn-summary-failures', summaryFailures.metric({ statistic: 'Sum', period: Duration.seconds(props.failureAlarmPeriodSeconds ?? 300) }), cloudwatch.TreatMissingData.NOT_BREACHING, 0, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      { periods: 1, alarmName: `${props.clusterName}-turn-summary-failures`, silenceWhenParked: false });
    // A stopping task whose Agent Computer browsers did not sleep may leave them running until their timeout.
    const stopSleepFailures = new logs.MetricFilter(this, 'AgentComputerStopSleepFailures', {
      logGroup, filterPattern: logs.FilterPattern.literal('"Agent Computer sleep at task stop failed"'),
      metricNamespace: 'BotCube/ChatService', metricName: 'AgentComputerStopSleepFailures', metricValue: '1',
    });
    alarm('agent-computer-stop-sleep-failures', stopSleepFailures.metric({ statistic: 'Sum', period: Duration.seconds(props.failureAlarmPeriodSeconds ?? 300) }), cloudwatch.TreatMissingData.NOT_BREACHING, 0, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      { periods: 1, alarmName: `${props.clusterName}-agent-computer-stop-sleep-failures`, silenceWhenParked: false });
    new CfnOutput(origin, 'AlertsTopicArn', { value: topic.topicArn });
    new CfnOutput(origin, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(origin, 'ServiceName', { value: service.serviceName });
    new CfnOutput(origin, 'TaskDefinitionArn', { value: task.taskDefinitionArn });
    new CfnOutput(origin, 'ChatTableName', { value: props.chatTable.tableName });
    // Live drains a stream for up to an hour so a deploy doesn't cut it. Park proceeds
    // immediately instead: the dependency updates the group to no delay before the
    // service scales to 0, and the group survives Parked (it costs nothing) so that
    // update happens in place rather than in the cleanup after the service.
    const target = new elb.ApplicationTargetGroup(this, 'Target', {
      vpc, port, protocol: elb.ApplicationProtocol.HTTP, targetType: elb.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(props.healthIntervalSeconds ?? 5), timeout: Duration.seconds(props.healthTimeoutSeconds ?? 4), healthyThresholdCount: props.healthHealthyThreshold ?? 2, unhealthyThresholdCount: props.healthUnhealthyThreshold ?? 6 },
      deregistrationDelay: Duration.seconds(props.parked ? 0 : (props.drainSeconds ?? 3600)),
    });
    // The logical ID it had as a listener target, so moving it here doesn't replace it.
    (target.node.defaultChild as elb.CfnTargetGroup).overrideLogicalId('OriginHttpsChatServiceGroup7CF46779');
    service.node.addDependency(target);
    // The origin has an ALB only while Live.
    if (!origin.alb) {
      // An empty list removes the association in place; omitting it would keep the old one.
      (service.node.defaultChild as ecs.CfnService).loadBalancers = [];
      return;
    }
    const { loadBalancer, listener } = origin.alb;
    loadBalancer.setAttribute('idle_timeout.timeout_seconds', String(props.loadBalancerIdleSeconds ?? 3600));
    service.attachToApplicationTargetGroup(target);
    // The Agent Computer CDP channel is for the harness only, which reaches it over
    // Cloud Map; the public listener answers it 404 before forwarding anything.
    // Priorities 5 and 10 never collide with the forward rule's former 1 mid-update.
    listener.addAction('AgentComputerCdp', {
      priority: 5, conditions: [elb.ListenerCondition.pathPatterns(['/agent-computer/cdp*'])],
      action: elb.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found\n' }),
    });
    listener.addTargetGroups('ChatService', {
      priority: 10, conditions: [elb.ListenerCondition.hostHeaders(props.hostnames)], targetGroups: [target],
    });
    alarm('alb-5xx', loadBalancer.metrics.httpCodeElb(elb.HttpCodeElb.ELB_5XX_COUNT, { statistic: 'Sum', period }), cloudwatch.TreatMissingData.NOT_BREACHING);
    alarm('target-5xx', target.metrics.httpCodeTarget(elb.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum', period }), cloudwatch.TreatMissingData.NOT_BREACHING);
    alarm('unhealthy-hosts', target.metrics.unhealthyHostCount({ statistic: 'Minimum', period }), cloudwatch.TreatMissingData.NOT_BREACHING);
    new CfnOutput(origin, 'TargetGroupArn', { value: target.targetGroupArn });
  }
}

function browserLiveViewArn(origin: PreviewOriginStack, browserId: string): string {
  return origin.formatArn({ service: 'bedrock-agentcore', ...(browserId === 'aws.browser.v1' ? { account: 'aws', resource: 'browser' } : { resource: 'browser-custom' }), resourceName: browserId });
}
