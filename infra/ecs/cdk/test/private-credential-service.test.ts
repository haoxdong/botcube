import { parkingTemplate } from './resolve-parking.js';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { ok as assert } from 'node:assert';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { PrivateCredentialService, type PrivateCredentialServiceProps } from '../lib/private-credential-service';

function synth(corporate = false, invocationTokenLength?: number, overrides: Partial<PrivateCredentialServiceProps> | ((stack: Stack) => Partial<PrivateCredentialServiceProps>) = {}) {
  const stack = new Stack(new App(), 'Credentials', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', {
    vpcId: 'vpc-fixture12345678', availabilityZones: ['us-east-1a', 'us-east-1c'],
    privateSubnetIds: ['subnet-fixture11111111', 'subnet-fixture22222222'],
  });
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
  new PrivateCredentialService(stack, 'Service', {
    ...(corporate ? {
      executionRole: iam.Role.fromRoleArn(stack, 'ExecutionRole', 'arn:aws:iam::123456789012:role/corporate-ecs', { mutable: false }),
      kmsKey: kms.Key.fromKeyArn(stack, 'CorporateKey', 'arn:aws:kms:us-east-1:123456789012:key/corporate-key'),
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(stack, 'Boundary', 'arn:aws:iam::123456789012:policy/boundary'),
      cpu: 1024, memoryLimitMiB: 2048, serviceName: 'corporate-credentials', dnsName: 'vault',
    } : {}),
    cluster, chatNetwork: ec2.SecurityGroup.fromSecurityGroupId(stack, 'Chat', 'sg-fixture11111111'),
    agentNetwork: ec2.SecurityGroup.fromSecurityGroupId(stack, 'Agent', 'sg-fixture22222222'),
    image: ecs.ContainerImage.fromRegistry('test-image'), tableName: 'test-vault',
    ...(invocationTokenLength === undefined ? {} : { invocationTokenLength }),
    rpcPath: '/rpc',
    namespaceName: 'namespace.test', alertsTopicName: 'existing-alerts', port: 8081,
    authBrowserId: 'test_auth_browser-1234567890', agentComputerBrowserId: 'test_agent_computer-1234567890', ...(typeof overrides === 'function' ? overrides(stack) : overrides),
  });
  return parkingTemplate(stack);
}

test('private DNS reaches one healthy Fargate task with only the two caller security groups', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '512', Memory: '1024',
    ContainerDefinitions: [Match.objectLike({ HealthCheck: { Command: ['CMD-SHELL', 'curl --fail --silent http://127.0.0.1:8081/health || exit 1'],
      Interval: 10, Timeout: 5, Retries: 9, StartPeriod: 5 } })],
  });
  template.hasResourceProperties('AWS::ECS::Service', {
    DesiredCount: 1, LaunchType: 'FARGATE',
    NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', SecurityGroups: [{ 'Fn::GetAtt': [Object.keys(template.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'Credentials/Service/Network' } }))[0], 'GroupId'] }], Subnets: ['subnet-fixture11111111', 'subnet-fixture22222222'] } },
    LoadBalancers: Match.absent(), ServiceRegistries: Match.anyValue(),
  });
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: 'namespace.test', Vpc: 'vpc-fixture12345678' });
  const groups = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
  const inbound = [...groups.flatMap(group => group.Properties.SecurityGroupIngress ?? []), ...Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => rule.Properties)];
  expect(inbound).toHaveLength(2);
  expect(inbound).toEqual(expect.arrayContaining(['sg-fixture11111111', 'sg-fixture22222222'].map(SourceSecurityGroupId => expect.objectContaining({ SourceSecurityGroupId, FromPort: 8081, ToPort: 8081, IpProtocol: 'tcp' }))));
  expect(inbound.every(rule => !rule.CidrIp && !rule.CidrIpv6)).toBe(true);
});

test('only the task role can decrypt or access vault data; the execution role can fetch the invocation secret', () => {
  const template = synth();
  const task = only(template, 'AWS::ECS::TaskDefinition').Properties;
  const key = only(template, 'AWS::KMS::Key');
  expect(key.Properties.KeyPolicy.Statement).toEqual(expect.arrayContaining([
    expect.objectContaining({ Effect: 'Deny', Action: 'kms:Decrypt', Condition: { ArnNotEquals: { 'aws:PrincipalArn': task.TaskRoleArn } } }),
  ]));
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-vault', DeletionProtectionEnabled: true,
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    ResourcePolicy: { PolicyDocument: Match.objectLike({ Statement: [Match.objectLike({
      Effect: 'Deny', Condition: { ArnNotEquals: { 'aws:PrincipalArn': task.TaskRoleArn } },
      Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:ExportTableToPointInTime']),
    })] }) },
  });
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const execution = policies.filter(policy => JSON.stringify(policy.Properties.Roles).includes(task.ExecutionRoleArn['Fn::GetAtt'][0]));
  expect(JSON.stringify(execution)).toContain('secretsmanager:GetSecretValue');
  expect(JSON.stringify(execution)).not.toMatch(/kms:Decrypt|dynamodb:/);
});

test('application errors publish ALARM and recovery to the existing topic', () => {
  const template = synth();
  template.resourceCountIs('AWS::SNS::Topic', 0);
  template.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '?"ERROR" ?"Traceback"' });
  const alarm = only(template, 'AWS::CloudWatch::Alarm').Properties;
  expect(alarm.AlarmActions).toEqual(alarm.OKActions);
  expect(JSON.stringify(alarm.AlarmActions)).toContain('existing-alerts');
  expect(alarm.Statistic).toBe('Sum');
  expect(alarm.Threshold).toBe(1);
});

test('a failed Plan Usage model listing alarms within five minutes and publishes recovery', () => {
  const template = synth();
  const namespace = { 'Fn::Join': ['', [{ Ref: only(template, 'AWS::ECS::Cluster').id }, '/CredentialService']] };
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    LogGroupName: { Ref: clusterGroup(template, 'credential-service-logs').id },
    FilterPattern: '[level, client, separator, request = "GET /openai/v1/models HTTP/1.1", status != 200, ...]',
    MetricTransformations: [{ DefaultValue: 0, MetricName: 'PlanCatalogFailures', MetricNamespace: namespace, MetricValue: '1' }],
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'PlanCatalogFailures', Namespace: namespace,
    Statistic: 'Sum', Period: 60, EvaluationPeriods: 1, Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
    AlarmActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
    OKActions: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }],
  });
});

test('the service reads its port, vault key, vault table and invocation token from its container environment', () => {
  const template = synth();
  const id = (type: string) => Object.keys(template.findResources(type))[0];
  const [container] = only(template, 'AWS::ECS::TaskDefinition').Properties.ContainerDefinitions;
  expect(container.PortMappings).toEqual([{ ContainerPort: 8081, Protocol: 'tcp' }]);
  expect(container.Environment).toEqual([
    { Name: 'AWS_REGION', Value: 'us-east-1' },
    { Name: 'PORT', Value: '8081' },
    { Name: 'BOTCUBE_VAULT_KMS_KEY_ID', Value: { 'Fn::GetAtt': [id('AWS::KMS::Key'), 'Arn'] } },
    { Name: 'BOTCUBE_VAULT_TABLE', Value: { Ref: id('AWS::DynamoDB::Table') } },
    { Name: 'BOTCUBE_SHEET_KMS_KEY_ID', Value: { 'Fn::GetAtt': [Object.keys(template.findResources('AWS::KMS::Key', { Properties: { KeySpec: 'RSA_2048' } }))[0], 'Arn'] } },
    { Name: 'AGENTCORE_BROWSER_ID', Value: 'test_auth_browser-1234567890' },
    { Name: 'AGENTCORE_AGENT_COMPUTER_BROWSER_ID', Value: 'test_agent_computer-1234567890' },
  ]);
  expect(container.Secrets).toEqual([{ Name: 'BOTCUBE_CREDENTIAL_INVOCATION_SECRET', ValueFrom: { Ref: id('AWS::SecretsManager::Secret') } }]);
});

/** The properties of the one resource of a type. */
function only(template: Template, type: string) {
  const [entry] = Object.entries(template.findResources(type));
  assert(entry, `no ${type} resource`);
  const [id, resource] = entry;
  return { id, Properties: resource.Properties, DependsOn: resource.DependsOn };
}

/** The log group named `/<cluster>/<name>`. */
function clusterGroup(template: Template, name: string) {
  const cluster = only(template, 'AWS::ECS::Cluster').id;
  const [entry] = Object.entries(template.findResources('AWS::Logs::LogGroup', { Properties: { LogGroupName: { 'Fn::Join': ['', ['/', { Ref: cluster }, `/${name}`]] } } }));
  assert(entry, `no /<cluster>/${name} log group`);
  const [id, resource] = entry;
  return { id, Properties: resource.Properties };
}

test('each caller reaches the RPC port through its own named rule', () => {
  const template = synth();
  const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => [rule.Properties.SourceSecurityGroupId, rule.Properties.Description]);
  expect(rules).toEqual([['sg-fixture11111111', 'Chat Service RPC'], ['sg-fixture22222222', 'Harness RPC']]);
});

test('the task runs on Linux x86-64 and logs to a group kept 30 days', () => {
  const template = synth();
  const task = only(template, 'AWS::ECS::TaskDefinition').Properties;
  const logs = clusterGroup(template, 'credential-service-logs');
  expect(task.RuntimePlatform).toEqual({ CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' });
  expect(task.ContainerDefinitions[0]).toMatchObject({
    Name: 'credential-service',
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: logs.id }, 'awslogs-stream-prefix': 'credential-service', 'awslogs-region': 'us-east-1' } },
  });
  expect(logs.Properties.RetentionInDays).toBe(30);
});

test('audit events are copied into the group the service used to log to, which keeps them a year', () => {
  const template = synth();
  const audit = clusterGroup(template, 'credential-service');
  const recent = clusterGroup(template, 'credential-service-logs');
  expect(audit).toMatchObject({ id: 'ServiceLogs205D48C6', Properties: { RetentionInDays: 365 } });
  const copy = only(template, 'AWS::Lambda::Function');
  expect(copy.Properties).toMatchObject({
    Handler: 'credential_audit_copy.handler', Runtime: 'python3.12',
    Environment: { Variables: { AUDIT_LOG_GROUP: { Ref: audit.id } } },
  });
  const subscription = only(template, 'AWS::Logs::SubscriptionFilter');
  expect(subscription.Properties).toEqual({
    LogGroupName: { Ref: recent.id }, FilterPattern: '{ $.event = * && $.accountId = * }',
    DestinationArn: { 'Fn::GetAtt': [copy.id, 'Arn'] },
  });
  const copyRole = copy.Properties.Role['Fn::GetAtt'][0];
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles[0].Ref === copyRole).flatMap(policy => policy.Properties.PolicyDocument.Statement);
  expect(statements).toEqual([{ Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::GetAtt': [audit.id, 'Arn'] } }]);
  expect(only(template, 'AWS::ECS::Service').DependsOn).toContain(subscription.id);
  const copyLogs = template.toJSON().Resources[copy.Properties.LoggingConfig.LogGroup.Ref];
  expect(copyLogs.Properties.RetentionInDays).toBe(30);
});

test('a failed audit copy alarms on the alerts topic within five minutes and clears with OK', () => {
  const template = synth();
  const topic = [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:us-east-1:123456789012:existing-alerts']] }];
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: { Ref: only(template, 'AWS::Lambda::Function').id } }],
    Statistic: 'Sum', Period: 300, Threshold: 1, EvaluationPeriods: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
    AlarmActions: topic, OKActions: topic,
  });
});

test('the vault key rotates, and the vault is keyed by account and provider, billed on demand and denies every data action to other principals', () => {
  const template = synth();
  const taskRole = only(template, 'AWS::ECS::TaskDefinition').Properties.TaskRoleArn;
  const key = only(template, 'AWS::KMS::Key');
  const table = only(template, 'AWS::DynamoDB::Table').Properties;
  const others = { ArnNotEquals: { 'aws:PrincipalArn': taskRole } };
  expect(key.Properties.EnableKeyRotation).toBe(true);
  expect(key.Properties.KeyPolicy.Statement[1]).toEqual({ Action: 'kms:Decrypt', Condition: others, Effect: 'Deny', Principal: { AWS: '*' }, Resource: '*' });
  expect(table).toMatchObject({
    AttributeDefinitions: [{ AttributeName: 'accountId', AttributeType: 'S' }, { AttributeName: 'provider', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'accountId', KeyType: 'HASH' }, { AttributeName: 'provider', KeyType: 'RANGE' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
  expect(table.ResourcePolicy.PolicyDocument.Statement).toEqual([{
    Action: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan',
      'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem',
      'dynamodb:ConditionCheckItem', 'dynamodb:PartiQLSelect', 'dynamodb:PartiQLInsert',
      'dynamodb:PartiQLUpdate', 'dynamodb:PartiQLDelete', 'dynamodb:ExportTableToPointInTime'],
    Condition: others, Effect: 'Deny', Principal: { AWS: '*' }, Resource: '*',
  }]);
  const [policy] = Object.values(template.findResources('AWS::IAM::Policy')).filter(resource => resource.Properties.Roles[0].Ref === taskRole['Fn::GetAtt'][0]);
  assert(policy);
  expect(policy.Properties.PolicyDocument.Statement).toEqual([
    { Action: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Effect: 'Allow', Resource: { 'Fn::GetAtt': [key.id, 'Arn'] } },
    { Action: ['kms:GetPublicKey', 'kms:Decrypt'], Effect: 'Allow', Resource: { 'Fn::GetAtt': [Object.keys(template.findResources('AWS::KMS::Key', { Properties: { KeySpec: 'RSA_2048' } }))[0], 'Arn'] } },
    { Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'], Effect: 'Allow', Resource: [{ 'Fn::GetAtt': [only(template, 'AWS::DynamoDB::Table').id, 'Arn'] }] },
    expect.objectContaining({ Action: ['bedrock-agentcore:GetBrowserSession', 'bedrock-agentcore:ConnectBrowserAutomationStream'] }),
  ]);
});

test('Sign-in Sheet entry and session seeding reach only the two browsers\' automation streams, and cannot start, stop or watch browsers', () => {
  const template = synth();
  const taskRole = only(template, 'AWS::ECS::TaskDefinition').Properties.TaskRoleArn;
  const [policy] = Object.values(template.findResources('AWS::IAM::Policy')).filter(resource => resource.Properties.Roles[0].Ref === taskRole['Fn::GetAtt'][0]);
  assert(policy);
  expect(policy.Properties.PolicyDocument.Statement).toContainEqual({
    Action: ['bedrock-agentcore:GetBrowserSession', 'bedrock-agentcore:ConnectBrowserAutomationStream'], Effect: 'Allow',
    Resource: ['test_auth_browser-1234567890', 'test_agent_computer-1234567890'].map(browser =>
      ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock-agentcore:us-east-1:123456789012:browser-custom/${browser}`]] })),
  });
});

test('the invocation token is a generated 64-character alphanumeric secret', () => {
  expect(only(synth(), 'AWS::SecretsManager::Secret').Properties).toEqual({ GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 64 } });
});

test.each([1, 31, 0, -1, 32.5, NaN, Infinity, -Infinity])('rejects invocation token length %s before generating a signing secret', invocationTokenLength => {
  expect(() => synth(false, invocationTokenLength)).toThrow('invocationTokenLength must be an integer of at least 32 characters');
});

test.each([32, 96])('generates the requested secure %s-character invocation token', invocationTokenLength => {
  expect(only(synth(false, invocationTokenLength), 'AWS::SecretsManager::Secret').Properties)
    .toEqual({ GenerateSecretString: { ExcludePunctuation: true, PasswordLength: invocationTokenLength } });
});

test('the service registers as credentials with a 10-second A record and rolls back failed deploys', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'credential-service', DeploymentConfiguration: Match.objectLike({
    MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true },
  }) });
  template.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'credentials', DnsConfig: Match.objectLike({ DnsRecords: [{ TTL: 10, Type: 'A' }] }) });
});

test('logged errors count in the cluster namespace and alarm on the first in five minutes', () => {
  const template = synth();
  const namespace = { 'Fn::Join': ['', [{ Ref: only(template, 'AWS::ECS::Cluster').id }, '/CredentialService']] };
  expect(only(template, 'AWS::Logs::MetricFilter').Properties).toMatchObject({
    LogGroupName: { Ref: clusterGroup(template, 'credential-service-logs').id },
    MetricTransformations: [{ DefaultValue: 0, MetricName: 'Errors', MetricNamespace: namespace, MetricValue: '1' }],
  });
  expect(only(template, 'AWS::CloudWatch::Alarm').Properties).toMatchObject({
    MetricName: 'Errors', Namespace: namespace, Period: 300, EvaluationPeriods: 1, TreatMissingData: 'notBreaching',
  });
});

test('the construct outputs its URL and the ids the Smoke Test reads', () => {
  const template = synth();
  const id = (type: string) => only(template, type).id;
  expect(template.toJSON().Outputs).toEqual({
    CredentialServiceUrl: { Value: 'http://credentials.namespace.test:8081/rpc' },
    CredentialServiceName: { Value: { 'Fn::GetAtt': [id('AWS::ECS::Service'), 'Name'] } },
    CredentialTaskDefinitionArn: { Value: { Ref: id('AWS::ECS::TaskDefinition') } },
    CredentialTaskRoleArn: { Value: only(template, 'AWS::ECS::TaskDefinition').Properties.TaskRoleArn },
    CredentialSecurityGroupId: { Value: { 'Fn::GetAtt': [id('AWS::EC2::SecurityGroup'), 'GroupId'] } },
    CredentialVaultKeyArn: { Value: { 'Fn::GetAtt': [id('AWS::KMS::Key'), 'Arn'] } },
    CredentialVaultTableName: { Value: { Ref: id('AWS::DynamoDB::Table') } },
    CredentialLogGroupName: { Value: { Ref: clusterGroup(template, 'credential-service-logs').id } },
    CredentialAuditLogGroupName: { Value: { Ref: clusterGroup(template, 'credential-service').id } },
    CredentialErrorAlarmName: { Value: { Ref: id('AWS::CloudWatch::Alarm') } },
    CredentialPlanCatalogAlarmName: { Value: { Ref: Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'PlanCatalogFailures' } }))[0] } },
    CredentialInvocationSecretArn: { Value: { Ref: id('AWS::SecretsManager::Secret') } },
  });
});

test('corporate resources supply the real execution role and vault key without generated replacements', () => {
  const template = synth(true);
  expect(Object.values(template.findResources('AWS::ECS::TaskDefinition')).map(resource => ({ cpu: resource.Properties.Cpu, memory: resource.Properties.Memory, executionRole: resource.Properties.ExecutionRoleArn }))).toMatchSnapshot();
  expect(Object.values(synth().findResources('AWS::ECS::TaskDefinition')).map(resource => ({ cpu: resource.Properties.Cpu, memory: resource.Properties.Memory, executionRole: resource.Properties.ExecutionRoleArn }))).toMatchSnapshot();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '1024', Memory: '2048', ExecutionRoleArn: 'arn:aws:iam::123456789012:role/corporate-ecs',
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([{ Name: 'BOTCUBE_VAULT_KMS_KEY_ID', Value: 'arn:aws:kms:us-east-1:123456789012:key/corporate-key' }]) })]),
  });
  template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'corporate-credentials' });
  template.hasOutput('CredentialServiceUrl', { Value: 'http://vault.namespace.test:8081/rpc' });
  template.resourceCountIs('AWS::KMS::Key', 1);
  for (const role of Object.values(template.findResources('AWS::IAM::Role'))) expect(role.Properties.PermissionsBoundary).toBe('arn:aws:iam::123456789012:policy/boundary');
  expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('corporate-ecs');
});

test('adopter names reach Credential Service tasks, roles, network, secret and error alarm', () => {
  const template = synth(false, undefined, {
    errorMetricFilterName: 'adopter-vault-filter', taskFamily: 'adopter-vault-task', taskRoleName: 'adopter-vault-role', executionRoleName: 'adopter-vault-execution',
    securityGroupName: 'adopter-vault-network', invocationSecretName: 'adopter-vault-secret', errorAlarmName: 'adopter-vault-errors',
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: 'adopter-vault-task' });
  for (const RoleName of ['adopter-vault-role', 'adopter-vault-execution']) template.hasResourceProperties('AWS::IAM::Role', { RoleName });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'adopter-vault-network' });
  template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'adopter-vault-secret' });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'adopter-vault-errors' });
  template.hasResourceProperties('AWS::Logs::MetricFilter', { FilterName: 'adopter-vault-filter' });
});

test('adopter invocation secret is reused and retains ownership of its name', () => {
  const imported = (stack: Stack) => secretsmanager.Secret.fromSecretCompleteArn(stack, 'OwnedSecret', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:owned-vault-secret-ABCDEF');
  const template = synth(false, undefined, stack => ({ invocationSecret: imported(stack) }));
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: [Match.objectLike({ Secrets: [{ Name: 'BOTCUBE_CREDENTIAL_INVOCATION_SECRET', ValueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:owned-vault-secret-ABCDEF' }] })] });
  expect(() => synth(false, undefined, stack => ({ invocationSecret: imported(stack), invocationSecretName: 'replacement' }))).toThrow('imported invocationSecret owns its name');
  expect(() => synth(true, undefined, { executionRoleName: 'replacement' })).toThrow('imported executionRole owns its name');
});

test('Sign-in Sheets use a retained RSA key shared by replacement tasks and decryptable only by Credential Service', () => {
  const template = synth();
  const entries = Object.entries(template.findResources('AWS::KMS::Key', { Properties: { KeySpec: 'RSA_2048' } }));
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  assert(entry);
  const [id, key] = entry;
  expect(key).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: { KeyUsage: 'ENCRYPT_DECRYPT' } });
  const task = only(template, 'AWS::ECS::TaskDefinition').Properties;
  expect(key.Properties.KeyPolicy.Statement).toContainEqual(expect.objectContaining({
    Effect: 'Deny', Action: 'kms:Decrypt', Condition: { ArnNotEquals: { 'aws:PrincipalArn': task.TaskRoleArn } },
  }));
  expect(task.ContainerDefinitions[0].Environment).toContainEqual({ Name: 'BOTCUBE_SHEET_KMS_KEY_ID', Value: { 'Fn::GetAtt': [id, 'Arn'] } });
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const taskPolicies = policies.filter(policy => JSON.stringify(policy.Properties.Roles).includes(task.TaskRoleArn['Fn::GetAtt'][0]));
  expect(taskPolicies.flatMap(policy => policy.Properties.PolicyDocument.Statement)).toContainEqual({
    Effect: 'Allow', Action: ['kms:GetPublicKey', 'kms:Decrypt'], Resource: { 'Fn::GetAtt': [id, 'Arn'] },
  });
});
