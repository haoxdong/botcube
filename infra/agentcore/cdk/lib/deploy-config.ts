import {
  ConfigIO,
  setSessionProjectRoot,
  type AgentCoreProjectSpec,
  type AwsDeploymentTarget,
} from '@aws/agentcore-cdk';
import * as fs from 'fs';
import * as path from 'path';

export interface PrivateNatBrowserIdentity {
  name: string;
  id: string;
  vpcId: string;
  browserSecurityGroupId: string;
  extension: { bucket: string; prefix: string; versionId: string };
  subnets: Array<{ id: string; availabilityZone: string; cidrBlock: string }>;
}

export interface DeployIdentity {
  aws: {
    account: string;
    region: string;
    cloudFormation: { stackFamily: string };
    agentCore: {
      runtime: string;
      memory: string;
      sessionApiFunction: string;
      sessionApiAlias: string;
    } &
      // The runtime network places the runtime in the private NAT browser's subnets.
      (
        | { runtimeNetworkParameter?: undefined; privateNatBrowser?: PrivateNatBrowserIdentity }
        | { runtimeNetworkParameter: string; privateNatBrowser: PrivateNatBrowserIdentity }
      );
    ecr: { repository: string };
    codeBuild: { project: string };
    lambda: { family: string };
    iam: {
      runtimeRole: string;
      memoryRole: string;
      lambdaRole: string;
      codeBuildRole: string;
      sessionApiRole: string;
    };
  };
  artifacts: { toolStaging: { hook: string } };
}

export interface DeployConfig {
  deployRoot: string;
  identity: DeployIdentity;
  spec: AgentCoreProjectSpec;
  targets: AwsDeploymentTarget[];
}

function readDeployIdentity(deployRoot: string): DeployIdentity {
  const identityPath = path.join(deployRoot, 'identity.json');
  // identity.json is operator input: check the fields it must carry before trusting its shape.
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as {
    aws?: Partial<DeployIdentity['aws']>;
  };
  if (!identity.aws?.account || !identity.aws.region) {
    throw new Error(`Invalid Cartridge deploy identity at ${identityPath}`);
  }
  return identity as DeployIdentity;
}

/**
 * Load the active Cartridge deploy directory and fail loud before synthesis when
 * its AgentCore config does not match identity.json.
 */
export async function loadDeployConfig(configuredRoot: string | undefined, cwd: string): Promise<DeployConfig> {
  if (!configuredRoot) {
    throw new Error('CARTRIDGE_DEPLOY_ROOT must point to the active Cartridge deploy directory');
  }
  const deployRoot = path.resolve(cwd, configuredRoot);
  const configRoot = path.join(deployRoot, 'agentcore');
  const identity = readDeployIdentity(deployRoot);
  setSessionProjectRoot(deployRoot);
  const configIO = new ConfigIO({ baseDir: configRoot });

  const spec = await configIO.readProjectSpec();
  const targets = await configIO.readAWSDeploymentTargets();

  if (targets.length === 0) {
    throw new Error(`No deployment targets configured in ${path.join(configRoot, 'aws-targets.json')}`);
  }

  for (const target of targets) {
    if (target.account !== identity.aws.account || target.region !== identity.aws.region) {
      throw new Error(`AWS target ${target.name} does not match identity.json account and region`);
    }
  }

  const unsupported = {
    payments: spec.payments ?? [],
    harnesses: spec.harnesses ?? [],
    agentCoreGateways: spec.agentCoreGateways,
    credentials: spec.credentials,
    'knowledge-base connectors': (spec.knowledgeBases ?? [])
      .flatMap(kb => kb.dataSources)
      .filter(ds => ds.type !== 'S3'),
  };
  for (const [feature, entries] of Object.entries(unsupported)) {
    if (entries.length > 0) throw new Error(`agentcore.json configures ${feature}, which this app does not deploy`);
  }

  if (spec.runtimes.length === 0) throw new Error('agentcore.json must configure a runtime');

  return { deployRoot, identity, spec, targets };
}
