import type { BotCubeConfig } from './schema.js';
import type { Principal } from './principals.js';

export const NETWORK_INTERFACES = ['CreateNetworkInterface', 'DeleteNetworkInterface', 'DescribeNetworkInterfaces', 'DescribeSubnets',
  'AssignPrivateIpAddresses', 'UnassignPrivateIpAddresses'].map(action => `ec2:${action}`);
const CHAT_TABLE_ACTIONS = ['BatchGetItem', 'BatchWriteItem', 'ConditionCheckItem', 'DeleteItem', 'DescribeTable', 'GetItem', 'GetRecords',
  'GetShardIterator', 'PutItem', 'Query', 'Scan', 'UpdateItem'].map(action => `dynamodb:${action}`);
const VAULT_TABLE_ACTIONS = ['ConditionCheckItem', 'DeleteItem', 'GetItem', 'PutItem', 'Query', 'UpdateItem'].map(action => `dynamodb:${action}`);
const KEY_USE = ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'];
const PARKING = 'production parking functions';
const ORIGIN_SMOKE = "the deploy role's origin smoke test";

type Existing = NonNullable<BotCubeConfig['existing']>;

/** The supplied VPC when it brings its own egress, with `network.natGateways` 0; none when BotCube creates its NAT in it. */
export function ownEgressVpc({ network, existing }: Pick<BotCubeConfig, 'network' | 'existing'>) {
  return network.natGateways ? undefined : existing.vpc;
}
interface SuppliableGrant {
  readonly to: Principal;
  readonly actions: readonly string[];
  /** The deploy identity field that names the role, so the operator can grant it before the first deploy. */
  readonly role?: string;
  /** Where the actions apply, from the resource's name, when that is not the resource itself. */
  readonly on?: (name: string) => string;
}
interface Suppliable {
  /** What BotCube creates in its place; absent, it creates and grants nothing, as for AgentCore Memory on its AWS owned key. */
  readonly created?: string;
  readonly name: (existing: Existing, config: BotCubeConfig) => string | undefined;
  /** What a BotCube role needs on it, granted when BotCube creates it and existing with it otherwise. */
  readonly grant?: readonly SuppliableGrant[];
  /** What the deploy machinery and AWS services need on it, granted the same way. */
  readonly others?: Readonly<Record<string, readonly string[]>>;
}

/** Each resource BotCube creates unless the BotCube Config supplies it with its grants (ADR 0091). */
export const SUPPLIABLE: Readonly<Record<string, Suppliable>> = {
  vpc: {
    created: "the private subnets' NAT gateway, its Elastic IP and route",
    name: (_existing, config) => ownEgressVpc(config)?.vpcId,
    others: {
      "every other Lambda function's role, the deploy's own included": NETWORK_INTERFACES,
      'its private subnets a route, by a NAT gateway or VPC endpoints': ['to each egress host below'],
    },
  },
  'browsers.link': { name: ({ browsers }) => browsers?.link && `${browsers.link.browserId} (security group ${browsers.link.securityGroupId})` },
  'kmsKeys.vault': { created: "the Credential Service's vault key", name: ({ kmsKeys }) => kmsKeys?.vault, grant: [{ to: 'credentialService', actions: KEY_USE }] },
  'kmsKeys.sheet': {
    name: ({ kmsKeys }) => kmsKeys?.sheet,
    grant: [{
      to: 'credentialService',
      actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GetPublicKey'],
      on: (aliasArn) => {
        const [arn, alias] = aliasArn.split(':alias/');
        return `${arn}:key/* if ForAnyValue:StringEquals kms:ResourceAliases alias/${alias}`;
      },
    }],
  },
  'kmsKeys.memory': { name: ({ kmsKeys }) => kmsKeys?.memory, others: { 'AgentCore Memory execution role': KEY_USE } },
  'kmsKeys.images': { created: "the bot image repository's key", name: ({ kmsKeys }) => kmsKeys?.images, grant: [{ to: 'harness', actions: ['kms:Decrypt'] }] },
  'kmsKeys.functions': {
    name: ({ kmsKeys }) => kmsKeys?.functions,
    others: { "the Credential Service's audit-copy function's role": ['kms:Decrypt'], "the deploy role, which sets the function's environment": ['kms:CreateGrant', 'kms:Encrypt'] },
  },
  'tables.chat': {
    created: 'the chat table and its stream',
    name: ({ tables }) => tables?.chat?.tableName,
    grant: [{ to: 'chatService', actions: CHAT_TABLE_ACTIONS }],
    others: {
      [PARKING]: ['DeleteItem', 'DescribeStream', 'GetItem', 'GetRecords', 'GetShardIterator', 'ListStreams', 'PutItem', 'Query', 'UpdateItem'].map(action => `dynamodb:${action}`),
      [ORIGIN_SMOKE]: ['dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    },
  },
  'tables.vault': { created: "the Credential Service's vault table", name: ({ tables }) => tables?.vault?.tableName, grant: [{ to: 'credentialService', actions: VAULT_TABLE_ACTIONS }] },
  'buckets.connectionLogs': {
    created: "the origin load balancer's connection logs bucket",
    name: ({ buckets }) => buckets?.connectionLogs,
    others: { 'Elastic Load Balancing log delivery': ['s3:PutObject'] },
  },
  'buckets.slots': { name: ({ buckets }) => buckets?.slots?.bucketName },
  credentialService: {
    created: "the Credential Service's private DNS namespace and Cloud Map service",
    name: ({ credentialService }) => credentialService?.url,
  },
  files: {
    created: 'the Files file system, its mount targets and access points',
    name: ({ files }) => files && `${files.fileSystemId} (KMS key ${files.kmsKey})`,
    grant: ([['chatService', 'chatServiceTaskRole'], ['agentComputerBrowser', 'agentComputerBrowserRole'], ['filesMount', 'filesMountRole']] as const)
      .map(([to, role]) => ({ to, role: `aws.iam.${role}`, actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'] })),
    others: {
      'NFS clients in the existing private subnets': ["TCP 2049 to the file system's mount target in each subnet"],
      'the existing VPC': ["a resolver that answers <fileSystemId>.efs.<region>.amazonaws.com, the name ECS mounts the Chat Service's own Files volume by: ECS takes no mount target address"],
    },
  },
};
