import { Duration } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { parkServiceIngress } from './park-state.js';
import type { DeployIdentity } from './production-identity.js';
import type { PreviewOriginStack } from './preview-origin-stack.js';
import type { PrivateCredentialService } from './private-credential-service.js';

/** Below the Chat Service's forward rule (10); a host of its own never matches the Chat Service's hosts. */
const PUBLIC_RULE_PRIORITY = 7;
const RAW_RULE_PRIORITY = 8;

export interface CredentialServicePublicRoute {
  hostname: string;
  rpcPath: string;
  port: number;
  /** The paths under `rpcPath` the User's browser may reach; the service's other routes stay off the listener. */
  paths: readonly string[];
  chatTable: ITable;
  /** The operator supplied the chat table with its grants: the service is granted nothing on it. */
  chatTableSupplied: boolean;
  /** The partition-key prefixes of the Chat table rows the service may read and write; none, no access. */
  chatTableKeyPrefixes: readonly string[];
  /** A host the service serves at every path, such as a product's raw service origin. */
  rawHostname: string | undefined;
}

/** Publish the product's service on its own host through the origin's ALB, its private routes kept off the listener. */
export function publishCredentialService(origin: PreviewOriginStack, credentials: PrivateCredentialService, route: CredentialServicePublicRoute): void {
  credentials.container.addEnvironment('BOTCUBE_CHAT_TABLE', route.chatTable.tableName);
  if (route.rawHostname !== undefined) {
    credentials.container.addEnvironment('BOTCUBE_RAW_SERVICE_HOST', route.rawHostname);
    credentials.container.addEnvironment('BOTCUBE_RAW_SERVICE_RPC_PATH', route.rpcPath);
  }
  if (route.chatTableKeyPrefixes.length && !route.chatTableSupplied) credentials.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'], resources: [route.chatTable.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': route.chatTableKeyPrefixes.map(prefix => `${prefix}*`) },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    },
  }));
  // The origin has an ALB only while Live.
  if (!origin.alb) return;
  const target = new elb.ApplicationTargetGroup(credentials, 'PublicTarget', {
    vpc: credentials.service.cluster.vpc, port: route.port, protocol: elb.ApplicationProtocol.HTTP, targetType: elb.TargetType.IP,
    // A wake waits on this check; at the 30-second default it took 83 s after the service was listening.
    healthCheck: {
      path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(5), timeout: Duration.seconds(4),
      healthyThresholdCount: 2, unhealthyThresholdCount: 6,
    },
    deregistrationDelay: Duration.seconds(30),
  });
  credentials.service.attachToApplicationTargetGroup(target);
  new elb.ApplicationListenerRule(credentials, 'PublicRoute', {
    listener: origin.alb.listener, priority: PUBLIC_RULE_PRIORITY, targetGroups: [target],
    conditions: [
      elb.ListenerCondition.hostHeaders([route.hostname]),
      elb.ListenerCondition.pathPatterns(route.paths.map(path => `${route.rpcPath}${path}`)),
    ],
  });
  if (route.rawHostname !== undefined) new elb.ApplicationListenerRule(credentials, 'RawRoute', {
    listener: origin.alb.listener, priority: RAW_RULE_PRIORITY, targetGroups: [target],
    conditions: [elb.ListenerCondition.hostHeaders([route.rawHostname])],
  });
  parkServiceIngress(credentials.service, target, origin, credentials.container.containerName, route.port);
}

export function rawServiceHostname({ domains, aws }: DeployIdentity): string | undefined {
  const [origin] = domains.rawServiceOrigins ?? [];
  if (origin !== undefined && aws.ecs.credentialService.publicHostname === undefined) {
    throw new Error('Deploy identity domains.rawServiceOrigins: requires aws.ecs.credentialService.publicHostname');
  }
  return origin === undefined ? undefined : new URL(origin).hostname;
}
