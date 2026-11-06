import * as path from 'node:path';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ChatStorageStack } from './chat-storage-stack.js';
import type { PreviewChatService } from './preview-chat-service.js';
import type { PreviewOriginStack } from './preview-origin-stack.js';

/**
 * Files on EFS: mount targets in the browser subnets, and the Lambda that serves each
 * signed upload or download link straight from the file system. Its only egress is NFS, so links need
 * neither the NAT nor a Chat Service task and keep working while production is parked. The Chat
 * Service, Browsers and Runtime start using it behind FILES_STORE=efs.
 */
export function addFilesLinks(origin: PreviewOriginStack, chat: PreviewChatService, storage: ChatStorageStack, browsers: { subnets: Array<{ id: string; availabilityZone: string }> }, cubeRoot: string, corsOrigins: string[]) {
  const { vpc } = chat.cluster;
  const links = new ec2.SecurityGroup(origin, 'FilesLinksNetwork', { vpc, allowAllOutbound: false });
  const mountTargets = new ec2.SecurityGroup(origin, 'FilesEfsMountTargets', { vpc, allowAllOutbound: false });
  mountTargets.addIngressRule(links, ec2.Port.tcp(2049), 'The Files Lambda serves links');
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
  cfn.fileSystemConfigs = [{ arn: accounts.attrArn, localMountPath: '/mnt/files' }];
  targets.forEach(target => cfn.addDependency(target));
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
    resources: [storage.filesEfs.attrArn],
    conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': accounts.attrArn } },
  }));
  const url = fn.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
    invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    // The web UI uploads in chunks and reads a reply's PDF from the link, as it did from the bucket.
    cors: { allowedOrigins: corsOrigins, allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.PUT], allowedHeaders: ['content-type', 'range'], exposedHeaders: ['content-range', 'content-length'] },
  });
  new CfnOutput(origin, 'FilesLinksUrl', { value: url.url });
  new CfnOutput(origin, 'FilesSigningKeyArn', { value: key.secretArn });
}
