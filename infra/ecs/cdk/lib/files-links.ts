import { FilesAccessPointPool } from './files-access-point-pool.js';
import * as path from 'node:path';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Secret as ContainerSecret } from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ChatStorageStack, SuppliedFiles } from './chat-storage-stack.js';
import { optionalPhysicalName } from './physical-name.js';
import type { PreviewChatService } from './preview-chat-service.js';
import type { PreviewOriginStack } from './preview-origin-stack.js';

/**
 * Files on EFS: mount targets in the browser subnets, and the Lambda that serves each
 * signed upload or download link straight from the file system. Its only egress is NFS, so links need
 * neither the NAT nor a Chat Service task and keep working while production is parked.
 */
export function addFilesLinks(origin: PreviewOriginStack, chat: PreviewChatService, storage: ChatStorageStack, browsers: { subnets: Array<{ id: string; availabilityZone: string; cidrBlock?: string }> }, cubeRoot: string, corsOrigins: string[], clients: ec2.ISecurityGroup[] = [],
  roleNames?: { mount: string; links: string }) {
  const { vpc } = chat.cluster;
  const supplied = storage.suppliedFiles;
  const links = new ec2.SecurityGroup(origin, 'FilesLinksNetwork', { vpc, allowAllOutbound: false });
  const { targets, accounts } = supplied ? suppliedFilesNetwork(origin, links, browsers, supplied) : createdFilesNetwork(origin, chat, storage, links, browsers, clients);
  const grantMount = (grant: (statement: iam.PolicyStatement) => unknown, accessPointArn: string, operator: 'StringEquals' | 'ArnLike' = 'StringEquals') => {
    if (!supplied) grant(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [storage.filesEfs.attrArn],
      conditions: { [operator]: { 'elasticfilesystem:AccessPointArn': accessPointArn } },
    }));
  };
  const key = new Secret(origin, 'FilesSigningKey', { generateSecretString: { passwordLength: 64, excludePunctuation: true } });
  const fn = new lambda.Function(origin, 'FilesLinks', {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(cubeRoot, 'infra/ecs/files'), { exclude: ['*.test.ts'] }),
    memorySize: 1024,
    // A streamed download runs at Lambda's 2 MB/s past its first 6 MB: 200 MB, its cap, takes ~100 s.
    timeout: Duration.minutes(5),
    vpc,
    vpcSubnets: { subnets: browsers.subnets.map((subnet, index) => ec2.Subnet.fromSubnetAttributes(origin, `FilesLinksSubnet${index}`, { subnetId: subnet.id, availabilityZone: subnet.availabilityZone })) },
    securityGroups: [links],
    // Resolved by CloudFormation at deploy: the parked VPC has no route to Secrets Manager.
    environment: { FILES_SIGNING_KEY: key.secretValue.unsafeUnwrap() },
    logGroup: new logs.LogGroup(origin, 'FilesLinksLogs', { retention: logs.RetentionDays.ONE_MONTH }),
  });
  const cfn = fn.node.defaultChild as lambda.CfnFunction;
  if (roleNames) (fn.role?.node.defaultChild as iam.CfnRole).roleName = roleNames.links;
  cfn.fileSystemConfigs = [{ arn: accounts.attrArn, localMountPath: '/mnt/files' }];
  targets.forEach(target => cfn.addDependency(target));
  grantMount(statement => fn.addToRolePolicy(statement), accounts.attrArn);
  const url = fn.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
    invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    // The web UI uploads in chunks and reads a reply's PDF from the link, as it did from the bucket.
    cors: { allowedOrigins: corsOrigins, allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.PUT], allowedHeaders: ['content-type', 'range'], exposedHeaders: ['content-range', 'content-length'] },
  });
  chat.task.addVolume({
    name: 'files-efs',
    efsVolumeConfiguration: {
      fileSystemId: storage.filesEfs.ref,
      transitEncryption: 'ENABLED',
      authorizationConfig: { accessPointId: accounts.id, iam: 'ENABLED' },
    },
  });
  chat.container.addMountPoints({ sourceVolume: 'files-efs', containerPath: '/mnt/files-efs', readOnly: false });
  grantMount(statement => chat.task.addToTaskRolePolicy(statement), accounts.attrArn);
  const mode: unknown = origin.node.tryGetContext('filesAccessPointMode') ?? 'runtime';
  if (mode !== 'runtime' && mode !== 'pool') throw new Error('filesAccessPointMode must be runtime or pool');
  if (supplied) {
    addPoolAlarm(origin, chat, supplied.accessPoints.length, 'Add access points to supplied.files.accessPoints.');
  } else if (mode === 'pool') {
    addFilesPool(origin, chat, storage, cubeRoot);
  } else {
    chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:CreateAccessPoint'], resources: [storage.filesEfs.attrArn],
    }));
    chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:DeleteAccessPoint'],
      resources: [origin.formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: '*' })],
    }));
    // EFS DescribeAccessPoints does not support resource-level permissions.
    chat.task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['elasticfilesystem:DescribeAccessPoints'], resources: ['*'] }));
  }
  const mount = new iam.Role(origin, 'FilesMountRole', {
    ...optionalPhysicalName('roleName', roleNames?.mount),
    assumedBy: chat.task.taskRole,
    maxSessionDuration: Duration.hours(1),
  });
  grantMount(statement => mount.addToPrincipalPolicy(statement), origin.formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: '*' }), 'ArnLike');
  mount.grantAssumeRole(chat.task.taskRole);
  if (!supplied) {
    const target = targets[0];
    if (!target) throw new Error('Files EFS requires a mount target');
    chat.container.addEnvironment('BOTCUBE_FILES_MOUNT_TARGET_IP', target.attrIpAddress);
  }
  chat.container.addEnvironment('BOTCUBE_FILES_EFS_ARN', storage.filesEfs.attrArn);
  chat.container.addEnvironment('BOTCUBE_FILES_EFS_ROOT', '/mnt/files-efs');
  chat.container.addEnvironment('BOTCUBE_FILES_LINKS_URL', url.url);
  chat.container.addEnvironment('BOTCUBE_FILES_MOUNT_ROLE_ARN', mount.roleArn);
  // CDK Secret's `T | undefined` getters conflict with ISecret's optional properties under exactOptionalPropertyTypes.
  chat.container.addSecret('BOTCUBE_FILES_SIGNING_KEY', ContainerSecret.fromSecretsManager(key as ISecret));
  targets.forEach(target => chat.service.node.addDependency(target));
  chat.service.node.addDependency(...(accounts.created ? [accounts.created] : []), chat.task.taskRole);
  new CfnOutput(origin, 'FilesLinksUrl', { value: url.url });
  new CfnOutput(origin, 'FilesSigningKeyArn', { value: key.secretArn });
}

function addFilesPool(origin: PreviewOriginStack, chat: PreviewChatService, storage: ChatStorageStack, cubeRoot: string) {
  const count = Number(origin.node.tryGetContext('filesAccessPointPoolSize') ?? 100);
  if (!Number.isSafeInteger(count) || count < 1 || count > 9999) throw new Error('filesAccessPointPoolSize must be an integer from 1 to 9999; the shared mount uses one access point of EFS’s 10000-point quota');
  const pool = new FilesAccessPointPool(origin, 'FilesPool', {
    fileSystemId: storage.filesEfs.ref, fileSystemArn: storage.filesEfs.attrArn, capacity: count, source: path.join(cubeRoot, 'infra/ecs/files-pool'), alertsTopic: chat.alertsTopic,
  });
  pool.bucket.grantRead(chat.task.taskRole);
  chat.container.addEnvironment('BOTCUBE_FILES_POOL_MANIFEST', JSON.stringify(pool.manifest));
  chat.service.node.addDependency(pool.ready);
  addPoolAlarm(origin, chat, count, 'Increase filesAccessPointPoolSize.');
}

function addPoolAlarm(origin: PreviewOriginStack, chat: PreviewChatService, capacity: number, remedy: string) {
  const metric = new logs.MetricFilter(origin, 'FilesPoolUsage', {
    logGroup: chat.logGroup,
    filterPattern: logs.FilterPattern.exists('$.filesPoolUsed'),
    metricNamespace: 'BotCube/Files', metricName: `${origin.stackName}-PoolUsed`, metricValue: '$.filesPoolUsed',
  }).metric({ statistic: 'Maximum', period: Duration.minutes(5) });
  const alarm = new cloudwatch.Alarm(origin, 'FilesPoolCapacity', {
    metric, threshold: Math.ceil(capacity * 0.8), evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    alarmDescription: `At least 80% of Files pool slots are leased to Users or quarantined for cleanup. ${remedy}`,
  });
  alarm.addAlarmAction(new actions.SnsAction(chat.alertsTopic));
}

interface FilesNetwork { targets: efs.CfnMountTarget[]; accounts: { id: string; attrArn: string; created?: efs.CfnAccessPoint } }

function createdFilesNetwork(origin: PreviewOriginStack, chat: PreviewChatService, storage: ChatStorageStack, links: ec2.SecurityGroup,
  browsers: { subnets: Array<{ id: string }> }, clients: ec2.ISecurityGroup[]): FilesNetwork {
  const mountTargets = new ec2.SecurityGroup(origin, 'FilesEfsMountTargets', { vpc: chat.cluster.vpc, allowAllOutbound: false });
  mountTargets.addIngressRule(links, ec2.Port.tcp(2049), 'The Files Lambda serves links');
  mountTargets.addIngressRule(chat.network, ec2.Port.tcp(2049), 'Chat Service mounts Files');
  clients.forEach(client => mountTargets.addIngressRule(client, ec2.Port.tcp(2049), 'Account sessions mount Files'));
  links.addEgressRule(mountTargets, ec2.Port.tcp(2049), 'NFS only: links work without the NAT');
  const targets = browsers.subnets.map((subnet, index) => new efs.CfnMountTarget(origin, `FilesEfsMountTarget${index}`, {
    fileSystemId: storage.filesEfs.ref, subnetId: subnet.id, securityGroups: [mountTargets.securityGroupId],
  }));
  // Every account's directory, as the uid each account's own access point uses.
  const accounts = new efs.CfnAccessPoint(origin, 'FilesEfsAccounts', {
    fileSystemId: storage.filesEfs.ref,
    posixUser: { uid: '1000', gid: '1000' },
    rootDirectory: { path: '/accounts', creationInfo: { ownerUid: '1000', ownerGid: '1000', permissions: '750' } },
  });
  return { targets, accounts: { id: accounts.ref, attrArn: accounts.attrArn, created: accounts } };
}

function suppliedFilesNetwork(origin: PreviewOriginStack, links: ec2.SecurityGroup, browsers: { subnets: Array<{ id: string; cidrBlock?: string }> },
  { accountsAccessPointId }: SuppliedFiles): FilesNetwork {
  for (const { id, cidrBlock } of browsers.subnets) {
    if (!cidrBlock) throw new Error(`Supplied Files need subnet ${id}'s cidrBlock, where the file system's mount target takes NFS`);
    links.addEgressRule(ec2.Peer.ipv4(cidrBlock), ec2.Port.tcp(2049), 'NFS only: links work without the NAT');
  }
  const attrArn = origin.formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: accountsAccessPointId });
  return { targets: [], accounts: { id: accountsAccessPointId, attrArn } };
}
