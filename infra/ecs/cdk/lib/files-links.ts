import { FilesAccessPointPool } from './files-access-point-pool.js';
import * as path from 'node:path';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Secret as ContainerSecret } from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ChatStorageStack, ExistingFiles } from './chat-storage-stack.js';
import { optionalPhysicalName } from './physical-name.js';
import type { PreviewChatService } from './preview-chat-service.js';
import type { PreviewOriginStack } from './preview-origin-stack.js';

/** Where the Chat Service's container mounts every account's Files directory, the root the Chat Service reads them under. */
export const CHAT_FILES_MOUNT = '/mnt/files-efs';

/**
 * Files on EFS: mount targets in the browser subnets, the Chat Service's mount of every account's directory,
 * and the key it signs each upload or download link with, which it serves itself.
 */
export function addFilesLinks(origin: PreviewOriginStack, chat: PreviewChatService, storage: ChatStorageStack, browsers: { subnets: Array<{ id: string }> }, cubeRoot: string, clients: ec2.ISecurityGroup[] = [],
  mountRoleName?: string) {
  const existing = storage.existingFiles;
  const { targets, accounts } = existing ? existingFilesNetwork(origin, existing) : createdFilesNetwork(origin, chat, storage, browsers, clients);
  const grantMount = (grant: (statement: iam.PolicyStatement) => unknown, accessPointArn: string, operator: 'StringEquals' | 'ArnLike' = 'StringEquals') => {
    if (!existing) grant(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [storage.filesEfs.attrArn],
      conditions: { [operator]: { 'elasticfilesystem:AccessPointArn': accessPointArn } },
    }));
  };
  const key = new Secret(origin, 'FilesSigningKey', { generateSecretString: { passwordLength: 64, excludePunctuation: true } });
  chat.task.addVolume({
    name: 'files-efs',
    efsVolumeConfiguration: {
      fileSystemId: storage.filesEfs.ref,
      transitEncryption: 'ENABLED',
      authorizationConfig: { accessPointId: accounts.id, iam: 'ENABLED' },
    },
  });
  chat.container.addMountPoints({ sourceVolume: 'files-efs', containerPath: CHAT_FILES_MOUNT, readOnly: false });
  grantMount(statement => chat.task.addToTaskRolePolicy(statement), accounts.attrArn);
  const mode: unknown = origin.node.tryGetContext('filesAccessPointMode') ?? 'runtime';
  if (mode !== 'runtime' && mode !== 'pool') throw new Error('filesAccessPointMode must be runtime or pool');
  if (existing) {
    addPoolAlarm(origin, chat, existing.accessPoints.length, 'Add access points to existing.files.accessPoints.');
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
    ...optionalPhysicalName('roleName', mountRoleName),
    assumedBy: chat.task.taskRole,
    maxSessionDuration: Duration.hours(1),
  });
  grantMount(statement => mount.addToPrincipalPolicy(statement), origin.formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: '*' }), 'ArnLike');
  mount.grantAssumeRole(chat.task.taskRole);
  if (!existing) {
    const target = targets[0];
    if (!target) throw new Error('Files EFS requires a mount target');
    chat.container.addEnvironment('BOTCUBE_FILES_MOUNT_TARGET_IP', target.attrIpAddress);
  }
  chat.container.addEnvironment('BOTCUBE_FILES_EFS_ARN', storage.filesEfs.attrArn);
  chat.container.addEnvironment('BOTCUBE_FILES_MOUNT_ROLE_ARN', mount.roleArn);
  // CDK Secret's `T | undefined` getters conflict with ISecret's optional properties under exactOptionalPropertyTypes.
  chat.container.addSecret('BOTCUBE_FILES_SIGNING_KEY', ContainerSecret.fromSecretsManager(key as ISecret));
  targets.forEach(target => chat.service.node.addDependency(target));
  chat.service.node.addDependency(...(accounts.created ? [accounts.created] : []), chat.task.taskRole);
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

function createdFilesNetwork(origin: PreviewOriginStack, chat: PreviewChatService, storage: ChatStorageStack,
  browsers: { subnets: Array<{ id: string }> }, clients: ec2.ISecurityGroup[]): FilesNetwork {
  const mountTargets = new ec2.SecurityGroup(origin, 'FilesEfsMountTargets', { vpc: chat.cluster.vpc, allowAllOutbound: false });
  mountTargets.addIngressRule(chat.network, ec2.Port.tcp(2049), 'Chat Service mounts Files');
  clients.forEach(client => mountTargets.addIngressRule(client, ec2.Port.tcp(2049), 'Account sessions mount Files'));
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

function existingFilesNetwork(origin: PreviewOriginStack, { accountsAccessPointId }: ExistingFiles): FilesNetwork {
  const attrArn = origin.formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: accountsAccessPointId });
  return { targets: [], accounts: { id: accountsAccessPointId, attrArn } };
}
