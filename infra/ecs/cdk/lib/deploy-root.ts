import * as path from 'node:path';
import { readDeployment, deploymentNames, fillName, type DeploymentConfig } from 'botcube-config/read';
import type { SynthesizedConfig } from './parking-transition.js';
import type { DeployIdentity } from './production-identity.js';
import { projectDir } from './project-dir.js';

/**
 * The active deploy directory, named by `BOTCUBE_DEPLOY_ROOT` and resolved from the working directory.
 */
export function activeDeployRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.BOTCUBE_DEPLOY_ROOT;
  if (!root) throw new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory');
  return path.resolve(root);
}

export { projectDir };

/** The BotCube Config beside the deploy root, which its identity is built from. */
export function deployRootConfig(deployRoot: string): SynthesizedConfig {
  return { path: path.join(deployRoot, '../botcube.yaml') };
}

export function deployIdentity(deployRoot: string): DeployIdentity {
  const config = readDeployment(deployRoot);
  const names = deploymentNames(config);
  const { services } = config;
  const link = config.existing.browsers?.link;
  const identity = {
    aws: {
      account: config.env.account,
      region: config.env.region,
      cloudFormation: {
        stackFamily: config.name,
      },
      agentCore: {
        runtime: names.runtimeAgentRuntimeName,
        runtimeMonitoring: config.alarms?.runtime ? {
          alarmPrefix: names.runtimeAlarmNamePrefix,
          filterName: names.runtimeErrorsFilterName,
          metricNamespace: config.alarms.runtime.metricNamespace,
        } : undefined,
        runtimeNetworkParameter: config.existing.browsers?.link ? `/${config.name}/agentcore/security-group-id` : undefined,
        sessionApiFunction: names.sessionApiFunctionName,
        sessionApiAlias: 'live',
        agentComputerBrowser: {
          name: names.agentComputerBrowserName,
          profileNamePrefix: names.agentComputerBrowserProfileNamePrefix,
        },
        privateNatBrowser: link ? {
          name: names.linkBrowserName,
          id: link.browserId,
          vpcId: config.existing.vpc.vpcId,
          browserSecurityGroupId: link.securityGroupId,
          extension: config.agentCore?.browsers?.link ? {
            bucket: config.agentCore.browsers.link.extension.bucket,
            prefix: config.agentCore.browsers.link.extension.key,
            versionId: config.agentCore.browsers.link.extension.versionId,
          } : undefined,
          subnets: config.existing.vpc.privateSubnets.map(item => ({ id: item.subnetId, availabilityZone: item.availabilityZone, cidrBlock: item.ipv4CidrBlock })),
        } : undefined,
      },
      signInPool: signInPool(config),
      credentialService: {
        vpcId: config.existing.vpc.vpcId,
        port: 8081,
      },
      ecs: {
        privateNamespace: fillName('{name}.internal', config.name),
        parkedDnsTarget: 'parked.invalid',
        credentialService: {
          tableName: 'credential-vault-by-provider',
          rpcPath: services?.credentialService?.http?.path ?? "",
          publicHostname: config.domains.credentialService ? new URL(config.domains.credentialService).hostname : undefined,
          publicPaths: services?.credentialService?.http?.publicPaths,
          chatTableKeyPrefixes: services?.credentialService?.leadingKeyPrefixes,
        },
        chatService: {
          turnIdentityKeysSecretName: names.turnIdentityKeysSecretName,
        },
        cluster: names.clusterName,
        deployRoleName: names.deployRoleName,
        originPullCaCertificate: config.cloudflare?.originPull.caCertificate,
        originPullClientSecretName: names.originPullClientSecretName,
        originTokenSecretName: names.originTokenSecretName,
        previewOriginStackName: names.previewOriginStackName,
        privateEgress: config.network?.natGateways ? {
          stackName: names.privateEgressStackName,
          routeTableId: config.existing.vpc.privateSubnets[0]?.routeTableId,
          natGateway: {
            name: names.natGatewayName,
            publicSubnetId: config.existing.vpc.publicSubnets[0]?.subnetId,
          },
        } : undefined,
        apiHealth: {
          stackName: names.apiHealthStackName,
          alarmName: names.apiHealthAlarmName,
        },
        webLatency: {
          stackName: names.webLatencyStackName,
          appMonitorName: names.webAppMonitorName,
        },
        alertsTopicName: names.alertsTopicName,
        publicSubnets: config.existing.vpc.publicSubnets.map(item => ({ id: item.subnetId, availabilityZone: item.availabilityZone })),
        originOwnership: `${config.name}:preview-origin`,
        parkedWorkerName: `${config.name}-parked`,
        parking: {
          autoPark: config.parking?.autoPark ?? false,
          functionName: names.parkingFunctionName,
          slotBucket: config.existing.buckets?.slots?.bucketName,
          originSlotKey: "dev-slots/DEV_SLOT_ORIGIN",
        },
        originZone: config.cloudflare?.zone,
      },
      iam: {
        runtimeRole: names.runtimeRoleName,
        userMemoryRole: names.userMemoryRoleName,
        chatServiceTaskRole: config.names?.chatServiceTaskRoleName,
        filesMountRole: config.names?.filesMountRoleName,
        filesLinksRole: config.names?.filesLinksRoleName,
        agentComputerBrowserRole: config.names?.agentComputerBrowserRoleName,
      },
    },
    ssm: {
      runtimeArn: `/${config.name}/agentcore/runtime-arn`,
      parkState: names.parkStateParameterName,
    },
    domains: {
      chatService: config.domains.chatService,
      chatServicePreview: config.domains.chatServicePreview,
      rawServiceOrigins: config.domains.productService === undefined ? [] : [config.domains.productService],
    },
  };
  return identity as DeployIdentity;
}

function signInPool(config: DeploymentConfig) {
  const signIn = config.integrations?.signIn;
  const pool = signIn?.kind === 'oidc' ? signIn.userPool : undefined;
  if (!pool) return undefined;
  const { google } = pool;
  return {
        name: pool.userPoolName,
        domainPrefix: pool.domain,
        customDomain: pool.customDomain ? { name: pool.customDomain.domain, certificateArn: pool.customDomain.certificateArn } : undefined,
        callbackUrls: pool.callbackUrls,
        logoutUrls: pool.logoutUrls,
        email: { domain: pool.email.sesVerifiedDomain, from: pool.email.fromEmail, fromName: pool.email.fromName, sesVerified: pool.email.sesVerified },
        google: google ? { secretName: google.credential.secretId } : undefined,
        login: pool.login,
      };
}
