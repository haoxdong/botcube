import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { ok as assert } from 'node:assert';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { PrivateCredentialService, type PrivateCredentialServiceProps } from '../lib/private-credential-service';

function synth(legacyVault?: PrivateCredentialServiceProps['legacyVault'], corporate = false, invocationTokenLength?: number, overrides: Partial<PrivateCredentialServiceProps> | ((stack: Stack) => Partial<PrivateCredentialServiceProps>) = {}) {
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
    ...(legacyVault ? { legacyVault } : {}),
    ...(invocationTokenLength === undefined ? {} : { invocationTokenLength }),
    rpcPath: '/rpc', environmentKeys: { port: 'SERVICE_PORT', invocationToken: 'RPC_TOKEN', keyId: 'KEY', vaultTable: 'VAULT', legacyVaultTable: 'LEGACY_VAULT' },
    namespaceName: 'test.internal', alertsTopicName: 'existing-alerts', port: 8081, parked: false,
    authBrowserId: 'test_auth_browser-1234567890', agentComputerBrowserId: 'test_agent_computer-1234567890', ...(typeof overrides === 'function' ? overrides(stack) : overrides),
  });
  return Template.fromStack(stack);
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
  template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: 'test.internal', Vpc: 'vpc-fixture12345678' });
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

test('the service reads its port, vault key, vault table and invocation token from its container environment', () => {
  const template = synth();
  const id = (type: string) => Object.keys(template.findResources(type))[0];
  const [container] = only(template, 'AWS::ECS::TaskDefinition').Properties.ContainerDefinitions;
  expect(container.PortMappings).toEqual([{ ContainerPort: 8081, Protocol: 'tcp' }]);
  expect(container.Environment).toEqual([
    { Name: 'AWS_REGION', Value: 'us-east-1' },
    { Name: 'SERVICE_PORT', Value: '8081' },
    { Name: 'KEY', Value: { 'Fn::GetAtt': [id('AWS::KMS::Key'), 'Arn'] } },
    { Name: 'VAULT', Value: { Ref: id('AWS::DynamoDB::Table') } },
    { Name: 'AGENTCORE_BROWSER_ID', Value: 'test_auth_browser-1234567890' },
    { Name: 'AGENTCORE_AGENT_COMPUTER_BROWSER_ID', Value: 'test_agent_computer-1234567890' },
  ]);
  expect(container.Secrets).toEqual([{ Name: 'RPC_TOKEN', ValueFrom: { Ref: id('AWS::SecretsManager::Secret') } }]);
});

/** The properties of the one resource of a type. */
function only(template: Template, type: string) {
  const [entry] = Object.entries(template.findResources(type));
  assert(entry, `no ${type} resource`);
  const [id, resource] = entry;
  return { id, Properties: resource.Properties };
}

test('each caller reaches the RPC port through its own named rule', () => {
  const template = synth();
  const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => [rule.Properties.SourceSecurityGroupId, rule.Properties.Description]);
  expect(rules).toEqual([['sg-fixture11111111', 'Chat Service RPC'], ['sg-fixture22222222', 'Harness RPC']]);
});

test('the task runs on Linux x86-64 and logs to its own log group for a year', () => {
  const template = synth();
  const task = only(template, 'AWS::ECS::TaskDefinition').Properties;
  const logs = only(template, 'AWS::Logs::LogGroup');
  expect(task.RuntimePlatform).toEqual({ CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' });
  expect(task.ContainerDefinitions[0]).toMatchObject({
    Name: 'credential-service',
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: logs.id }, 'awslogs-stream-prefix': 'credential-service', 'awslogs-region': 'us-east-1' } },
  });
  expect(logs.Properties).toEqual({ LogGroupName: { 'Fn::Join': ['', ['/', { Ref: only(template, 'AWS::ECS::Cluster').id }, '/credential-service']] }, RetentionInDays: 365 });
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
    { Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'], Effect: 'Allow', Resource: [{ 'Fn::GetAtt': [only(template, 'AWS::DynamoDB::Table').id, 'Arn'] }] },
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
  expect(() => synth(undefined, false, invocationTokenLength)).toThrow('invocationTokenLength must be an integer of at least 32 characters');
});

test.each([32, 96])('generates the requested secure %s-character invocation token', invocationTokenLength => {
  expect(only(synth(undefined, false, invocationTokenLength), 'AWS::SecretsManager::Secret').Properties)
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
  expect(only(template, 'AWS::Logs::MetricFilter').Properties.MetricTransformations).toEqual([{ DefaultValue: 0, MetricName: 'Errors', MetricNamespace: namespace, MetricValue: '1' }]);
  expect(only(template, 'AWS::CloudWatch::Alarm').Properties).toMatchObject({
    MetricName: 'Errors', Namespace: namespace, Period: 300, EvaluationPeriods: 1, TreatMissingData: 'notBreaching',
  });
});

test('the construct outputs its URL and the ids the Smoke Test reads', () => {
  const template = synth();
  const id = (type: string) => only(template, type).id;
  expect(template.toJSON().Outputs).toEqual({
    CredentialServiceUrl: { Value: 'http://credentials.test.internal:8081/rpc' },
    CredentialServiceName: { Value: { 'Fn::GetAtt': [id('AWS::ECS::Service'), 'Name'] } },
    CredentialTaskDefinitionArn: { Value: { Ref: id('AWS::ECS::TaskDefinition') } },
    CredentialTaskRoleArn: { Value: only(template, 'AWS::ECS::TaskDefinition').Properties.TaskRoleArn },
    CredentialSecurityGroupId: { Value: { 'Fn::GetAtt': [id('AWS::EC2::SecurityGroup'), 'GroupId'] } },
    CredentialVaultKeyArn: { Value: { 'Fn::GetAtt': [id('AWS::KMS::Key'), 'Arn'] } },
    CredentialVaultTableName: { Value: { Ref: id('AWS::DynamoDB::Table') } },
    CredentialLogGroupName: { Value: { Ref: id('AWS::Logs::LogGroup') } },
    CredentialErrorAlarmName: { Value: { Ref: id('AWS::CloudWatch::Alarm') } },
    CredentialInvocationSecretArn: { Value: { Ref: id('AWS::SecretsManager::Secret') } },
  });
});

describe('while the account-keyed Vault is kept for its migration', () => {
  const tables = (template: Template) => Object.fromEntries(Object.entries(template.findResources('AWS::DynamoDB::Table'))
    .map(([id, resource]) => [resource.Properties.TableName, { id, ...resource }]));

  test('it stays under the construct ID it was deployed with, retained and closed to every other principal', () => {
    const template = synth({ tableName: 'legacy-vault', mirrored: true });
    const taskRole = only(template, 'AWS::ECS::TaskDefinition').Properties.TaskRoleArn;
    const { 'legacy-vault': legacy, 'test-vault': vault } = tables(template);
    assert(legacy && vault);
    expect(legacy.id).toMatch(/^ServiceVault[0-9A-F]{8}$/);
    expect(vault.id).toMatch(/^ServiceProviderVault[0-9A-F]{8}$/);
    expect(legacy).toMatchObject({ DeletionPolicy: 'Retain', Properties: {
      KeySchema: [{ AttributeName: 'accountId', KeyType: 'HASH' }], DeletionProtectionEnabled: true,
      ResourcePolicy: { PolicyDocument: { Statement: [expect.objectContaining({ Effect: 'Deny', Condition: { ArnNotEquals: { 'aws:PrincipalArn': taskRole } } })] } },
    } });
  });

  test('the task role can scan it and condition a copy on it, and reaches the provider-keyed Vault only by key', () => {
    const template = synth({ tableName: 'legacy-vault', mirrored: true });
    const taskRole = only(template, 'AWS::ECS::TaskDefinition').Properties.TaskRoleArn;
    const { 'legacy-vault': legacy, 'test-vault': vault } = tables(template);
    assert(legacy && vault);
    const [policy] = Object.values(template.findResources('AWS::IAM::Policy')).filter(resource => resource.Properties.Roles[0].Ref === taskRole['Fn::GetAtt'][0]);
    assert(policy);
    expect(policy.Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining([
      { Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'], Effect: 'Allow', Resource: [{ 'Fn::GetAtt': [vault.id, 'Arn'] }] },
      { Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:ConditionCheckItem'], Effect: 'Allow', Resource: [{ 'Fn::GetAtt': [legacy.id, 'Arn'] }] },
    ]));
  });

  test.each([
    [true, true],
    [false, false],
  ])('mirrored=%s names it to the service: %s', (mirrored, named) => {
    const template = synth({ tableName: 'legacy-vault', mirrored });
    const { 'legacy-vault': legacy } = tables(template);
    assert(legacy);
    const [container] = only(template, 'AWS::ECS::TaskDefinition').Properties.ContainerDefinitions;
    expect(container.Environment.filter((entry: { Name: string }) => entry.Name === 'LEGACY_VAULT'))
      .toEqual(named ? [{ Name: 'LEGACY_VAULT', Value: { Ref: legacy.id } }] : []);
    expect(template.toJSON().Outputs.CredentialLegacyVaultTableName).toEqual({ Value: { Ref: legacy.id } });
  });
});


test('corporate resources supply the real execution role and vault key without generated replacements', () => {
  const template = synth(undefined, true);
  expect(Object.values(template.findResources('AWS::ECS::TaskDefinition')).map(resource => ({ cpu: resource.Properties.Cpu, memory: resource.Properties.Memory, executionRole: resource.Properties.ExecutionRoleArn }))).toMatchSnapshot();
  expect(Object.values(synth().findResources('AWS::ECS::TaskDefinition')).map(resource => ({ cpu: resource.Properties.Cpu, memory: resource.Properties.Memory, executionRole: resource.Properties.ExecutionRoleArn }))).toMatchSnapshot();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '1024', Memory: '2048', ExecutionRoleArn: 'arn:aws:iam::123456789012:role/corporate-ecs',
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Environment: Match.arrayWith([{ Name: 'KEY', Value: 'arn:aws:kms:us-east-1:123456789012:key/corporate-key' }]) })]),
  });
  template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'corporate-credentials' });
  template.hasOutput('CredentialServiceUrl', { Value: 'http://vault.test.internal:8081/rpc' });
  template.resourceCountIs('AWS::KMS::Key', 0);
  for (const role of Object.values(template.findResources('AWS::IAM::Role'))) expect(role.Properties.PermissionsBoundary).toBe('arn:aws:iam::123456789012:policy/boundary');
  expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('corporate-ecs');
});

test('adopter names reach Credential Service tasks, roles, network, secret and error alarm', () => {
  const template = synth(undefined, false, undefined, {
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
  const template = synth(undefined, false, undefined, stack => ({ invocationSecret: imported(stack) }));
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', { ContainerDefinitions: [Match.objectLike({ Secrets: [{ Name: 'RPC_TOKEN', ValueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:owned-vault-secret-ABCDEF' }] })] });
  expect(() => synth(undefined, false, undefined, stack => ({ invocationSecret: imported(stack), invocationSecretName: 'replacement' }))).toThrow('imported invocationSecret owns its name');
  expect(() => synth(undefined, true, undefined, { executionRoleName: 'replacement' })).toThrow('imported executionRole owns its name');
});
