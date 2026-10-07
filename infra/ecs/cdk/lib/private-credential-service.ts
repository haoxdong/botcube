import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface PrivateCredentialServiceProps {
  executionRole?: iam.IRole;
  kmsKey?: kms.IKey;
  permissionsBoundary?: iam.IManagedPolicy;
  subnets?: ec2.SubnetSelection;
  securityGroups?: ec2.ISecurityGroup[];
  healthIntervalSeconds?: number;
  healthTimeoutSeconds?: number;
  healthRetries?: number;
  healthStartPeriodSeconds?: number;
  desiredCount?: number;
  minHealthyPercent?: number;
  maxHealthyPercent?: number;
  errorAlarmPeriodSeconds?: number;
  errorAlarmThreshold?: number;
  cpu?: number;
  memoryLimitMiB?: number;
  serviceName?: string;
  logGroupName?: string;
  logStreamPrefix?: string;
  dnsName?: string;
  dnsTtlSeconds?: number;
  logRetention?: logs.RetentionDays;
  invocationTokenLength?: number;
  cluster: ecs.Cluster;
  chatNetwork: ec2.ISecurityGroup;
  agentNetwork: ec2.ISecurityGroup;
  image: ecs.ContainerImage;
  /** The Vault: one Durable Credential per (accountId, provider) (ADR 0078 decision 3). */
  tableName: string;
  /**
   * The account-keyed Vault it replaces, kept until the migration is verified. While `mirrored`,
   * the service reads it and writes both, and the migration can run; afterwards reads use only `tableName`.
   */
  legacyVault?: { tableName: string; mirrored: boolean };
  namespaceName: string;
  alertsTopicName: string;
  port: number;
  rpcPath: string;
  environmentKeys: { port: string; invocationToken: string; keyId: string; vaultTable: string; legacyVaultTable: string };
  /** Parked production runs no tasks; the vault, key and namespace stay. */
  parked: boolean;
  /** The AgentCore browser whose Auth Browser Sessions the Sign-in Sheet types into (ADR 0075). */
  authBrowserId: string;
  /** The AgentCore browser whose Agent Computer sessions are seeded with the account's session cookies (ADR 0075 decision 5). */
  agentComputerBrowserId: string;
}

/** Private credential custody, separate from both callers and their roles. */
export class PrivateCredentialService extends Construct {
  readonly task: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;
  readonly url: string;
  readonly invocationSecret: secretsmanager.Secret;
  /** The private DNS namespace the Harness resolves its callees in. */
  readonly namespace: discovery.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: PrivateCredentialServiceProps) {
    super(scope, id);
    const invocationTokenLength = props.invocationTokenLength ?? 64;
    // 32 alphanumeric characters provide about 190 bits of entropy for the owner-only ingest signing key.
    if (!Number.isInteger(invocationTokenLength) || invocationTokenLength < 32) {
      throw new Error('invocationTokenLength must be an integer of at least 32 characters');
    }
    const stack = Stack.of(this);
    if (props.permissionsBoundary) iam.PermissionsBoundary.of(this).apply(props.permissionsBoundary);
    const network = new ec2.SecurityGroup(this, 'Network', { vpc: props.cluster.vpc });
    network.connections.allowFrom(props.chatNetwork, ec2.Port.tcp(props.port), 'Chat Service RPC');
    network.connections.allowFrom(props.agentNetwork, ec2.Port.tcp(props.port), 'Harness RPC');
    const task = this.task = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.cpu ?? 512, memoryLimitMiB: props.memoryLimitMiB ?? 1024,
      ...(props.executionRole ? { executionRole: props.executionRole } : {}),
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const key = props.kmsKey ?? new kms.Key(this, 'VaultKey', {
      enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
    });
    if (!props.kmsKey) key.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()],
      actions: ['kms:Decrypt'], resources: ['*'],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': task.taskRole.roleArn } },
    }));
    if (props.kmsKey) task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: [key.keyArn] }));
    else key.grant(task.taskRole, 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey');
    const vault = (id: string, tableName: string, sortKey?: string) => {
      const table = new dynamodb.Table(this, id, {
        tableName,
        partitionKey: { name: 'accountId', type: dynamodb.AttributeType.STRING },
        ...(sortKey ? { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } } : {}),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true, removalPolicy: RemovalPolicy.RETAIN,
      });
      table.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()],
        actions: [
          'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan',
          'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem',
          'dynamodb:ConditionCheckItem', 'dynamodb:PartiQLSelect', 'dynamodb:PartiQLInsert',
          'dynamodb:PartiQLUpdate', 'dynamodb:PartiQLDelete', 'dynamodb:ExportTableToPointInTime',
        ], resources: ['*'],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': task.taskRole.roleArn } },
      }));
      return table;
    };
    const table = vault('ProviderVault', props.tableName, 'provider');
    // UpdateItem takes a rotating credential's refresh lease (ADR 0078 decision 4).
    table.grant(task.taskRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');
    // The construct ID the account-keyed table was deployed under; renaming it would replace the table.
    const legacy = props.legacyVault && vault('Vault', props.legacyVault.tableName);
    // The migration scans it and copies each item only while it is unchanged.
    legacy?.grant(task.taskRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:ConditionCheckItem');
    // Sign-in Sheet entry and session seeding: find a browser Session's automation stream and drive it.
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetBrowserSession', 'bedrock-agentcore:ConnectBrowserAutomationStream'],
      resources: [props.authBrowserId, props.agentComputerBrowserId].map(resourceName =>
        stack.formatArn({ service: 'bedrock-agentcore', resource: 'browser-custom', resourceName })),
    }));
    this.invocationSecret = new secretsmanager.Secret(this, 'InvocationSecret', {
      generateSecretString: { passwordLength: invocationTokenLength, excludePunctuation: true },
    });
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: props.logGroupName ?? `/${props.cluster.clusterName}/credential-service`, retention: props.logRetention ?? logs.RetentionDays.ONE_YEAR,
    });
    this.container = task.addContainer('credential-service', {
      image: props.image, portMappings: [{ containerPort: props.port }],
      environment: {
        AWS_REGION: stack.region, [props.environmentKeys.port]: String(props.port),
        [props.environmentKeys.keyId]: key.keyArn, [props.environmentKeys.vaultTable]: table.tableName,
        ...(legacy && props.legacyVault?.mirrored ? { [props.environmentKeys.legacyVaultTable]: legacy.tableName } : {}),
        AGENTCORE_BROWSER_ID: props.authBrowserId,
        AGENTCORE_AGENT_COMPUTER_BROWSER_ID: props.agentComputerBrowserId,
      },
      // aws-cdk-lib's Secret declares `T | undefined` getters where ISecret declares `prop?: T`,
      // which exactOptionalPropertyTypes rejects; the construct is its interface.
      secrets: { [props.environmentKeys.invocationToken]: ecs.Secret.fromSecretsManager(this.invocationSecret as secretsmanager.ISecret) },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.logStreamPrefix ?? 'credential-service', logGroup }),
      healthCheck: {
        command: ['CMD-SHELL', `curl --fail --silent http://127.0.0.1:${props.port}/health || exit 1`],
        interval: Duration.seconds(props.healthIntervalSeconds ?? 10), timeout: Duration.seconds(props.healthTimeoutSeconds ?? 5), retries: props.healthRetries ?? 9, startPeriod: Duration.seconds(props.healthStartPeriodSeconds ?? 5),
      },
    });
    const namespace = this.namespace = new discovery.PrivateDnsNamespace(this, 'Namespace', {
      name: props.namespaceName, vpc: props.cluster.vpc,
    });
    const service = new ecs.FargateService(this, 'Service', {
      // aws-cdk-lib's Cluster declares `T | undefined` getters where ICluster declares `prop?: T`,
      // which exactOptionalPropertyTypes rejects; the construct is its interface.
      cluster: props.cluster as ecs.ICluster, taskDefinition: task, serviceName: props.serviceName ?? 'credential-service', desiredCount: props.parked ? 0 : (props.desiredCount ?? 1),
      ...(props.subnets ? { vpcSubnets: props.subnets } : {}),
      assignPublicIp: false,
      securityGroups: [network, ...(props.securityGroups ?? [])], minHealthyPercent: props.minHealthyPercent ?? 100, maxHealthyPercent: props.maxHealthyPercent ?? 200,
      circuitBreaker: { rollback: true },
      cloudMapOptions: { name: props.dnsName ?? 'credentials', cloudMapNamespace: namespace, dnsRecordType: discovery.DnsRecordType.A, dnsTtl: Duration.seconds(props.dnsTtlSeconds ?? 10) },
    });
    this.url = `http://${props.dnsName ?? 'credentials'}.${props.namespaceName}:${props.port}${props.rpcPath}`;
    const errors = new logs.MetricFilter(this, 'Errors', {
      logGroup, filterPattern: logs.FilterPattern.anyTerm('ERROR', 'Traceback'),
      metricNamespace: `${props.cluster.clusterName}/CredentialService`, metricName: 'Errors', metricValue: '1', defaultValue: 0,
    });
    const alarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      metric: errors.metric({ period: Duration.seconds(props.errorAlarmPeriodSeconds ?? 300), statistic: 'Sum' }),
      threshold: props.errorAlarmThreshold ?? 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const topic = sns.Topic.fromTopicArn(this, 'Alerts', stack.formatArn({ service: 'sns', resource: props.alertsTopicName }));
    alarm.addAlarmAction(new actions.SnsAction(topic));
    alarm.addOkAction(new actions.SnsAction(topic));
    for (const [name, value] of Object.entries({
      CredentialServiceUrl: this.url, CredentialServiceName: service.serviceName,
      CredentialTaskDefinitionArn: task.taskDefinitionArn, CredentialTaskRoleArn: task.taskRole.roleArn,
      CredentialSecurityGroupId: network.securityGroupId, CredentialVaultKeyArn: key.keyArn,
      CredentialVaultTableName: table.tableName, CredentialLogGroupName: logGroup.logGroupName,
      CredentialErrorAlarmName: alarm.alarmName,
      // What the operator command signs Plan Usage ingest tokens with (ADR 0078 decision 5).
      CredentialInvocationSecretArn: this.invocationSecret.secretArn,
      ...(legacy ? { CredentialLegacyVaultTableName: legacy.tableName } : {}),
    })) new CfnOutput(stack, name, { value });
  }
}
