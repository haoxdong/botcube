import { parkState } from './park-state.js';
import { optionalPhysicalName } from './physical-name.js';
import { CfnOutput, CfnResource, Duration, Names, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { copyAuditEvents, type CredentialServiceImage } from './credential-audit-copy.js';
import { nameTaskRoles } from './task-role-names.js';

/** The environment names every bot's Credential Service, and the Chat Service that calls it, read. */
export const CREDENTIAL_SERVICE_ENV = {
  url: 'BOTCUBE_CREDENTIAL_SERVICE_URL',
  invocationToken: 'BOTCUBE_CREDENTIAL_INVOCATION_SECRET',
  port: 'PORT',
  keyId: 'BOTCUBE_VAULT_KMS_KEY_ID',
  sheetKeyAlias: 'BOTCUBE_SHEET_KMS_ALIAS',
  vaultTable: 'BOTCUBE_VAULT_TABLE',
} as const;

export interface PrivateCredentialServiceProps {
  /** Additional bot configuration; framework-owned environment keys take precedence. */
  environment?: Record<string, string>;
  invocationSecret?: secretsmanager.ISecret;
  errorMetricFilterName?: string;
  taskFamily?: string;
  taskRoleName?: string;
  executionRoleName?: string;
  securityGroupName?: string;
  invocationSecretName?: string;
  errorAlarmName?: string;
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
  /** The service's own logs, kept `logRetention` (default 30 days). */
  logGroupName?: string;
  /** Where the audit events are copied and kept a year. */
  auditLogGroupName?: string;
  logStreamPrefix?: string;
  dnsName?: string;
  dnsTtlSeconds?: number;
  logRetention?: logs.RetentionDays;
  invocationTokenLength?: number;
  cluster: ecs.Cluster;
  chatNetwork: ec2.ISecurityGroup;
  agentNetwork: ec2.ISecurityGroup;
  image: CredentialServiceImage;
  /** The Vault: one Durable Credential per (accountId, provider) (ADR 0078 decision 3). */
  tableName: string;
  /** A supplied vault table, with its grants, to use instead of creating `tableName`: the task is granted nothing on it. */
  suppliedVaultTableName?: string;
  /** A supplied key, with its grants, to encrypt the vault with instead of creating one: the task is granted nothing on it. */
  suppliedVaultKeyArn?: string;
  /** The alias ARN of a supplied RSA ENCRYPT_DECRYPT key, with its grants, for the Sign-in Sheet instead of creating one. */
  suppliedSheetKeyAlias?: string;
  /** A supplied key, with its grants, encrypting the audit-copy Lambda's environment instead of the AWS managed key. */
  suppliedFunctionsKeyArn?: string;
  /**
   * A supplied Credential Service Endpoint: callers get its URL, the tasks register into its target group and admit its
   * load balancer's security group, in place of the private DNS namespace and Cloud Map service, which are not created.
   */
  suppliedEndpoint?: { url: string; targetGroupArn: string; securityGroupId: string };
  /** Whether the service's image mounts the Sign-in Sheet routes; only then is a sheet key created when none is supplied. */
  sheetRoutes?: boolean;
  namespaceName: string;
  alertsTopicName: string;
  port: number;
  rpcPath: string;
  /** The AgentCore browser whose Auth Browser Sessions the Sign-in Sheet types into (ADR 0075). */
  authBrowserId: string;
  /** The AgentCore browser whose Agent Computer sessions are seeded with the account's session cookies (ADR 0075 decision 5). */
  agentComputerBrowserId: string;
}

/** The length of the invocation token the service generates, refusing options an imported secret owns. */
function validInvocationTokenLength(props: PrivateCredentialServiceProps): number {
  if (props.invocationSecret && (props.invocationSecretName !== undefined || props.invocationTokenLength !== undefined)) throw new Error('An imported invocationSecret owns its name and value; omit secret creation options');
  const invocationTokenLength = props.invocationTokenLength ?? 64;
  // 32 alphanumeric characters provide about 190 bits of entropy for the owner-only ingest signing key.
  if (!Number.isInteger(invocationTokenLength) || invocationTokenLength < 32) {
    throw new Error('invocationTokenLength must be an integer of at least 32 characters');
  }
  return invocationTokenLength;
}

/** Private credential custody, separate from both callers and their roles. */
export class PrivateCredentialService extends Construct {
  readonly task: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;
  readonly service: ecs.FargateService;
  readonly url: string;
  readonly invocationSecret: secretsmanager.Secret | secretsmanager.ISecret;
  /** The private DNS namespace the Harness resolves its callees in; absent behind a supplied Endpoint. */
  readonly namespace: discovery.PrivateDnsNamespace | undefined;

  constructor(scope: Construct, id: string, props: PrivateCredentialServiceProps) {
    super(scope, id);
    const invocationTokenLength = validInvocationTokenLength(props);
    const stack = Stack.of(this);
    if (props.permissionsBoundary) iam.PermissionsBoundary.of(this).apply(props.permissionsBoundary);
    const network = new ec2.SecurityGroup(this, 'Network', { vpc: props.cluster.vpc, ...optionalPhysicalName('securityGroupName', props.securityGroupName) });
    network.connections.allowFrom(props.chatNetwork, ec2.Port.tcp(props.port), 'Chat Service RPC');
    network.connections.allowFrom(props.agentNetwork, ec2.Port.tcp(props.port), 'Harness RPC');
    const task = this.task = new ecs.FargateTaskDefinition(this, 'Task', {
      ...optionalPhysicalName('family', props.taskFamily),
      cpu: props.cpu ?? 512, memoryLimitMiB: props.memoryLimitMiB ?? 1024,
      ...(props.executionRole ? { executionRole: props.executionRole } : {}),
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    nameTaskRoles(task, props.taskRoleName, props.executionRoleName, props.executionRole);
    const key = vaultKey(this, props, task);
    const sheetKeyAlias = signInSheetKeyAlias(this, props, task);
    const vault = (id: string, tableName: string, sortKey?: string) => {
      if (props.suppliedVaultTableName) return dynamodb.Table.fromTableName(this, id, props.suppliedVaultTableName);
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
    if (!props.suppliedVaultTableName) table.grant(task.taskRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem');
    // Sign-in Sheet entry and session seeding: find a browser Session's automation stream and drive it.
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetBrowserSession', 'bedrock-agentcore:ConnectBrowserAutomationStream'],
      resources: [props.authBrowserId, props.agentComputerBrowserId].map(resourceName =>
        stack.formatArn({ service: 'bedrock-agentcore', resource: 'browser-custom', resourceName })),
    }));
    this.invocationSecret = props.invocationSecret ?? new secretsmanager.Secret(this, 'InvocationSecret', {
      ...optionalPhysicalName('secretName', props.invocationSecretName),
      generateSecretString: { passwordLength: invocationTokenLength, excludePunctuation: true },
    });
    const logGroup = new logs.LogGroup(this, 'ServiceLogs', {
      logGroupName: props.logGroupName ?? `/${props.cluster.clusterName}/credential-service-logs`, retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
    });
    const audit = copyAuditEvents(this, logGroup, props.auditLogGroupName ?? `/${props.cluster.clusterName}/credential-service`, props.image, props.suppliedFunctionsKeyArn);
    this.container = task.addContainer('credential-service', {
      image: props.image.service, portMappings: [{ containerPort: props.port }],
      environment: {
        ...props.environment,
        AWS_REGION: stack.region, [CREDENTIAL_SERVICE_ENV.port]: String(props.port),
        [CREDENTIAL_SERVICE_ENV.keyId]: key.keyArn, [CREDENTIAL_SERVICE_ENV.vaultTable]: table.tableName,
        ...(sheetKeyAlias ? { [CREDENTIAL_SERVICE_ENV.sheetKeyAlias]: sheetKeyAlias } : {}),
        AGENTCORE_BROWSER_ID: props.authBrowserId,
        AGENTCORE_AGENT_COMPUTER_BROWSER_ID: props.agentComputerBrowserId,
      },
      // aws-cdk-lib's Secret declares `T | undefined` getters where ISecret declares `prop?: T`,
      // which exactOptionalPropertyTypes rejects; the construct is its interface.
      secrets: { [CREDENTIAL_SERVICE_ENV.invocationToken]: ecs.Secret.fromSecretsManager(this.invocationSecret as secretsmanager.ISecret) },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.logStreamPrefix ?? 'credential-service', logGroup }),
      healthCheck: {
        command: ['CMD-SHELL', `curl --fail --silent http://127.0.0.1:${props.port}/health || exit 1`],
        interval: Duration.seconds(props.healthIntervalSeconds ?? 10), timeout: Duration.seconds(props.healthTimeoutSeconds ?? 5), retries: props.healthRetries ?? 9, startPeriod: Duration.seconds(props.healthStartPeriodSeconds ?? 5),
      },
    });
    const endpoint = props.suppliedEndpoint;
    const namespace = this.namespace = endpoint ? undefined : new discovery.PrivateDnsNamespace(this, 'Namespace', {
      name: props.namespaceName, vpc: props.cluster.vpc,
    });
    const service = this.service = new ecs.FargateService(this, 'Service', {
      // aws-cdk-lib's Cluster declares `T | undefined` getters where ICluster declares `prop?: T`,
      // which exactOptionalPropertyTypes rejects; the construct is its interface.
      cluster: props.cluster as ecs.ICluster, taskDefinition: task, serviceName: props.serviceName ?? 'credential-service', desiredCount: parkState(this).credentialNumber(props.desiredCount ?? 1, 0),
      ...(props.subnets ? { vpcSubnets: props.subnets } : {}),
      assignPublicIp: false,
      securityGroups: [network, ...(props.securityGroups ?? [])], minHealthyPercent: props.minHealthyPercent ?? 100, maxHealthyPercent: props.maxHealthyPercent ?? 200,
      circuitBreaker: { rollback: true },
      ...(namespace ? {
        cloudMapOptions: { name: props.dnsName ?? 'credentials', cloudMapNamespace: namespace, dnsRecordType: discovery.DnsRecordType.A, dnsTtl: Duration.seconds(props.dnsTtlSeconds ?? 10) },
      } : {}),
    });
    service.node.addDependency(audit.subscription);
    if (endpoint) {
      const balancer = ec2.SecurityGroup.fromSecurityGroupId(this, 'EndpointBalancer', endpoint.securityGroupId, { mutable: false });
      network.connections.allowFrom(balancer, ec2.Port.tcp(props.port), "The supplied Endpoint's load balancer");
      service.attachToApplicationTargetGroup(elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(this, 'EndpointTargets', { targetGroupArn: endpoint.targetGroupArn }));
    }
    this.url = endpoint?.url ?? `http://${props.dnsName ?? 'credentials'}.${props.namespaceName}:${props.port}${props.rpcPath}`;
    const errors = new logs.MetricFilter(this, 'Errors', {
      ...optionalPhysicalName('filterName', props.errorMetricFilterName),
      logGroup, filterPattern: logs.FilterPattern.anyTerm('ERROR', 'Traceback'),
      metricNamespace: `${props.cluster.clusterName}/CredentialService`, metricName: 'Errors', metricValue: '1', defaultValue: 0,
    });
    const alarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      ...optionalPhysicalName('alarmName', props.errorAlarmName),
      metric: errors.metric({ period: Duration.seconds(props.errorAlarmPeriodSeconds ?? 300), statistic: 'Sum' }),
      threshold: props.errorAlarmThreshold ?? 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const monitoringCondition = parkState(this).credentialCondition;
    const topic = sns.Topic.fromTopicArn(this, 'Alerts', stack.formatArn({ service: 'sns', resource: props.alertsTopicName }));
    alarm.addAlarmAction(new actions.SnsAction(topic));
    alarm.addOkAction(new actions.SnsAction(topic));
    const planCatalogFailures = new logs.MetricFilter(this, 'PlanCatalogFailures', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('[level, client, separator, request = "GET /openai/v1/models HTTP/1.1", status != 200, ...]'),
      metricNamespace: `${props.cluster.clusterName}/CredentialService`, metricName: 'PlanCatalogFailures', metricValue: '1', defaultValue: 0,
    });
    const planCatalogAlarm = new cloudwatch.Alarm(this, 'PlanCatalogAlarm', {
      metric: planCatalogFailures.metric({ period: Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    planCatalogAlarm.addAlarmAction(new actions.SnsAction(topic));
    planCatalogAlarm.addOkAction(new actions.SnsAction(topic));
    const auditCopyAlarm = new cloudwatch.Alarm(this, 'AuditCopyAlarm', {
      metric: audit.copy.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    auditCopyAlarm.addAlarmAction(new actions.SnsAction(topic));
    auditCopyAlarm.addOkAction(new actions.SnsAction(topic));
    for (const monitor of [errors, planCatalogFailures, alarm, planCatalogAlarm, auditCopyAlarm]) {
      (monitor.node.defaultChild as CfnResource).cfnOptions.condition = monitoringCondition;
    }
    for (const [name, value] of Object.entries({
      CredentialServiceUrl: this.url, CredentialServiceName: service.serviceName,
      CredentialTaskDefinitionArn: task.taskDefinitionArn, CredentialTaskRoleArn: task.taskRole.roleArn,
      CredentialSecurityGroupId: network.securityGroupId, CredentialVaultKeyArn: key.keyArn,
      CredentialVaultTableName: table.tableName, CredentialLogGroupName: logGroup.logGroupName,
      CredentialAuditLogGroupName: audit.logGroup.logGroupName,
      CredentialErrorAlarmName: alarm.alarmName,
      CredentialPlanCatalogAlarmName: planCatalogAlarm.alarmName,
      // What the operator command signs Plan Usage ingest tokens with (ADR 0078 decision 5).
      CredentialInvocationSecretArn: this.invocationSecret.secretArn,
    })) new CfnOutput(stack, name, { value, ...(['CredentialErrorAlarmName', 'CredentialPlanCatalogAlarmName'].includes(name) ? { condition: monitoringCondition } : {}) });
  }
}

/** Only the task may decrypt with a key this construct creates. */
function denyDecryptToOthers(key: kms.Key, task: ecs.TaskDefinition) {
  key.addToResourcePolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()],
    actions: ['kms:Decrypt'], resources: ['*'],
    conditions: { ArnNotEquals: { 'aws:PrincipalArn': task.taskRole.roleArn } },
  }));
}

/** The vault's key: the one passed in, a supplied one by ARN, or a new one only the task may decrypt with. */
function vaultKey(scope: Construct, props: PrivateCredentialServiceProps, task: ecs.TaskDefinition): kms.IKey {
  if (props.kmsKey && props.suppliedVaultKeyArn) throw new Error('Choose kmsKey or suppliedVaultKeyArn, not both');
  if (props.suppliedVaultKeyArn) return kms.Key.fromKeyArn(scope, 'VaultKey', props.suppliedVaultKeyArn);
  const importedKey = props.kmsKey;
  // An imported key's policy is its owner's: the task role is granted the key, and the key's own deny is theirs to keep.
  if (importedKey) {
    task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: [importedKey.keyArn] }));
    return importedKey;
  }
  const key = new kms.Key(scope, 'VaultKey', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
  denyDecryptToOthers(key, task);
  key.grant(task.taskRole, 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey');
  return key;
}

function signInSheetKeyAlias(scope: Construct, props: PrivateCredentialServiceProps, task: ecs.TaskDefinition): string | undefined {
  if (props.suppliedSheetKeyAlias) return props.suppliedSheetKeyAlias;
  if (!props.sheetRoutes) return undefined;
  const sheetKey = new kms.Key(scope, 'SheetKey', {
    keySpec: kms.KeySpec.RSA_2048, keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  denyDecryptToOthers(sheetKey, task);
  const alias = new kms.Alias(scope, 'SheetKeyAlias', { aliasName: `alias/${Names.uniqueResourceName(sheetKey, { maxLength: 200 })}`, targetKey: sheetKey });
  const stack = Stack.of(scope);
  task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GetPublicKey'],
    resources: [stack.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
    conditions: { 'ForAnyValue:StringEquals': { 'kms:ResourceAliases': alias.aliasName } },
  }));
  return stack.formatArn({ service: 'kms', resource: alias.aliasName });
}
