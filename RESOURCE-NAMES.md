# Choose resource names and reuse existing resources

Set physical names on the interface that creates the resource, or supply an
existing CDK interface. Omitted settings retain the defaults. Stack names use
`StackProps.stackName` and the Cartridge deployment identity.

Names must satisfy the corresponding AWS resource's constraints. Inspect the
CloudFormation diff before changing names on an existing deployment; a name
change can replace a resource. Plan retained-storage migrations explicitly.
Logical IDs, AWS-assigned identifiers, CDK bootstrap assets, provider waiter
resources, and generated policy names remain implementation-managed.

## Name inputs

| Owning interface                                                                 | Physical name inputs                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AgentCorePhysicalIdentity](infra/agentcore/cdk/lib/cdk-stack.ts)                | Runtime, Memory, session API function and alias, ECR repository, CodeBuild project, container build function, and runtime/Memory/build/session API role names. The template deployment identity supplies these.                                                                                                                                                                    |
| [AgentCoreStackProps](infra/agentcore/cdk/lib/cdk-stack.ts)                      | `sessionApiLogGroupName`, `runtimeSecurityGroupName`. The latter names the automatically created runtime VPC group; supplied groups retain their own names.                                                                                                                                                                                                                        |
| [ChatStorageProps](infra/ecs/cdk/lib/chat-storage-stack.ts)                      | `tableName`, `filesBucketName`, `filesSyncRoleName`.                                                                                                                                                                                                                                                                                                                               |
| [PreviewChatServiceProps](infra/ecs/cdk/lib/preview-chat-service.ts)             | `clusterName`, `serviceName`, `logGroupName`, `reaperLogGroupName`, `scheduleGroupName`, `taskFamily`, `reaperTaskFamily`.                                                                                                                                                                                                                                                         |
| Chat task roles                                                                  | `taskRoleName`, `executionRoleName`, `reaperTaskRoleName`, `reaperExecutionRoleName`, `scheduledRunsRoleName`, `reaperInvocationRoleName`.                                                                                                                                                                                                                                         |
| Chat networking and custody                                                      | `securityGroupName`, `reaperSecurityGroupName`, `targetGroupName`, `turnMemorySecretName`.                                                                                                                                                                                                                                                                                         |
| Chat queues and reaper                                                           | `scheduledRunsQueueName`, `scheduledRunsFailedQueueName`, `reaperRuleName`.                                                                                                                                                                                                                                                                                                        |
| Chat alarms                                                                      | `alarmNames` partial map: `task-deficit`, `session-purge-failures`, `turn-summary-failures`, `agent-computer-stop-sleep-failures`, `alb-5xx`, `target-5xx`, `unhealthy-hosts`.                                                                                                                                                                                                     |
| Chat metric filters                                                              | `metricFilterNames` partial map: `sessionPurgeFailures`, `turnSummaryFailures`, `agentComputerStopSleepFailures`.                                                                                                                                                                                                                                                                  |
| [PrivateCredentialServiceProps](infra/ecs/cdk/lib/private-credential-service.ts) | `tableName`, `serviceName`, `logGroupName`, `dnsName`, `namespaceName`, `taskFamily`, `taskRoleName`, `executionRoleName`, `securityGroupName`, `invocationSecretName`, `errorAlarmName`, `errorMetricFilterName`.                                                                                                                                                                 |
| [PreviewOriginProps](infra/ecs/cdk/lib/preview-origin-stack.ts)                  | `securityGroupName`, `connectionLogsBucketName`, `trustStoreName`, `loadBalancerName`; `providerNames` keyed by `on_event` and `is_complete`, each accepting `functionName`, `logGroupName`, `roleName`.                                                                                                                                                                           |
| [WebLatencyStackProps](infra/ecs/cdk/lib/web-latency-stack.ts)                   | `appMonitorName`, `identityPoolName`, `guestRoleName`, `readerRoleName`.                                                                                                                                                                                                                                                                                                           |
| [ProductionOptions](infra/ecs/cdk/lib/production.ts)                             | `storage` exposes storage resource settings. `chat`, `credentials`, `originConfig`, and `webLatency` expose their corresponding settings. `originConfig` also accepts `agentNetworkSecurityGroupName`, `agentComputerSecurityGroupName`, `filesMountTargetsSecurityGroupName`, `agentComputerBrowserRoleName`, and `filesSyncRoleName` for the serving origin's Files access role. |

The storage sync role and serving origin's Files access role are separate
resources. `ProductionOptions.chatTableName` remains supported; supply it or
`storage.tableName`, not both. Log stream prefixes, existing secret references,
SNS alert topic names, and configured browser names retain their existing inputs.

`alarmNames['alb-5xx']` applies to the provided origin's ALB alarm.
You own ALB-wide alarms when supplying shared ingress; Chat retains its
target-group, task, and application alarms.

For a Chat Service with your existing ingress, add name choices alongside its
other configuration:

```ts
new PreviewChatService(stack, 'ChatService', {
  ...chatProps,
  ingress,
  taskFamily: 'adopter-chat',
  targetGroupName: 'adopter-chat-target',
  turnMemorySecretName: '/adopter/turn-memory',
  scheduledRunsQueueName: 'adopter-scheduled-runs',
});
```

Use the [ingress setup instructions](INTEGRATING.md#use-an-existing-load-balancer-and-listener)
to reserve listener priorities and configure shared ALB settings.

## Import resources you own

Storage accepts `chatTable: ITable` and `filesBucket: IBucket`. Importing them
skips table and bucket creation. BotCube still creates the Files file system
and its sync role and grants. The Files bucket must have S3 Files-compatible
versioning and encryption, and your application must configure upload CORS.
Imported buckets retain their existing SSL, encryption, CORS, and retention
settings. Omit `tableName` for an imported table and `filesBucketName` for an
imported bucket.

```ts
new ChatStorageStack(app, 'Storage', {
  ...storageProps,
  chatTable: dynamodb.Table.fromTableName(
    imports,
    'Sessions',
    'adopter-sessions'
  ),
  filesBucket: s3.Bucket.fromBucketName(
    imports,
    'Files',
    'adopter-files-unique-suffix'
  ),
});
```

For Chat, use `turnMemorySecret: ISecret` and `scheduledRunsQueue: IQueue`:

```ts
new PreviewChatService(stack, 'ChatService', {
  ...chatProps,
  ingress,
  turnMemorySecret: secretsmanager.Secret.fromSecretNameV2(
    stack,
    'TurnMemory',
    '/adopter/turn-memory'
  ),
  scheduledRunsQueue: sqs.Queue.fromQueueArn(
    stack,
    'Runs',
    'arn:aws:sqs:us-east-1:000000000000:adopter-scheduled-runs'
  ),
});
```

Replace the example resource names and ARN with your resources. Omit creation
names from `storageProps` and `chatProps` when importing the corresponding
resource. An imported Turn Memory secret conflicts with `turnMemorySecretName`.
An imported queue conflicts with queue and dead-letter names,
`scheduledRunVisibilitySeconds`, `scheduledRunRetentionDays`, and
`scheduledRunMaxReceiveCount`. Your application owns the imported queue's
visibility, retention, and redrive policy. BotCube grants task consumption and
Scheduler send permissions.

The Credential Service accepts `invocationSecret: ISecret`. Its existing value
must satisfy the service's invocation-token requirements. Omit
`invocationSecretName` and `invocationTokenLength` when importing it.

Imported execution roles and keys retain their existing ownership. Supplying
an execution role together with an execution-role name override fails because
a consumer cannot rename an imported role. Existing role, key, network, and
[ingress interface](INTEGRATING.md#use-an-existing-load-balancer-and-listener)
inputs remain supported, including deployment-time CDK references where the
construct accepts them.
