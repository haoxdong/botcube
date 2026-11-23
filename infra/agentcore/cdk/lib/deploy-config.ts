import { readDeployment, deploymentNames, type DeploymentConfig } from 'botcube-config/read';
import {
  AgentCoreProjectSpecSchema,
  AwsDeploymentTargetsSchema,
  setSessionProjectRoot,
  type AgentCoreProjectSpec,
  type AwsDeploymentTarget,
} from '@aws/agentcore-cdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RuntimePlatformVersion } from './runtime-platform';

/** This project's directory holds cdk.json, whether the app runs from source or from dist/. */
function projectDir(dir: string): string {
  if (fs.existsSync(path.join(dir, 'cdk.json'))) return dir;
  if (path.dirname(dir) === dir) throw new Error('The AgentCore CDK app has no cdk.json above it');
  return projectDir(path.dirname(dir));
}
const INFRA = path.resolve(projectDir(__dirname), '../..');

const PROJECT_DEFAULTS = { version: 1, managedBy: 'CDK', tags: { 'agentcore:created-by': 'agentcore-cli' } };
const RUNTIME_DEFAULTS = {
  build: 'Container',
  entrypoint: 'src/botcube_harness_deepagents/serving.py',
  // Every deploy runs BotCube's Harness, beside this infra.
  codeLocation: path.resolve(INFRA, '../harness/deepagents'),
  runtimeVersion: 'PYTHON_3_13',
  networkMode: 'PUBLIC',
  protocol: 'AGUI',
  envVars: [
    { name: 'AGENT_OBSERVABILITY_ENABLED', value: 'true' },
    { name: 'OTEL_PYTHON_DISTRO', value: 'aws_distro' },
    { name: 'OTEL_PYTHON_CONFIGURATOR', value: 'aws_configurator' },
    { name: 'OTEL_TRACES_SAMPLER', value: 'always_on' },
    { name: 'OTEL_METRICS_EXPORTER', value: 'none' },
    { name: 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED', value: 'false' },
    { name: 'TRACELOOP_TRACE_CONTENT', value: 'false' },
  ],
};
/** Memory keeps Session events for 365 days, the AgentCore maximum, and files every long-term record under its actor first (ADR 0033). */
const MEMORY_DEFAULTS = {
  eventExpiryDuration: 365,
  strategies: [
    { type: 'USER_PREFERENCE', name: 'UserPreferences', namespaceTemplates: ['/actors/{actorId}/preferences/'] },
    { type: 'SEMANTIC', name: 'SemanticFacts', namespaceTemplates: ['/actors/{actorId}/facts/'] },
    { type: 'SUMMARIZATION', name: 'SessionSummary', namespaceTemplates: ['/actors/{actorId}/summaries/{sessionId}/'] },
    {
      type: 'EPISODIC',
      name: 'EpisodicLearning',
      namespaceTemplates: ['/actors/{actorId}/episodes/{sessionId}/'],
      reflectionNamespaceTemplates: ['/actors/{actorId}/episodes/'],
    },
  ],
};

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
      platformVersion: RuntimePlatformVersion;
      maxLifetime?: number;
      idleRuntimeSessionTimeout?: number;
      rollbackVersion?: string;
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
      /** The role a Turn's JWT turns into Memory credentials for one user (ADR 0067 §8). */
      userMemoryRole: string;
      /** The Chat Service's task role, the only principal the `assume-role` adapter's Memory role trusts. */
      chatServiceTaskRole?: string;
      lambdaRole: string;
      codeBuildRole: string;
      sessionApiRole: string;
    };
  };
  /** The Chat Service's origin: its hostname, over https, issues the per-Turn JWT. */
  domains: { chatService: string };
}

export interface DeployConfig {
  deployRoot: string;
  identity: DeployIdentity;
  spec: AgentCoreProjectSpec;
  targets: AwsDeploymentTarget[];
  /** The Bot Image the Runtime runs, the BotCube Config's `agentCore.runtime.containerUri`; absent, it is built. */
  runtimeImage?: string;
  /** The BotCube Config's `tags`, on every stack. */
  tags?: Readonly<Record<string, string>>;
}

export function readDeployIdentity(deployRoot: string, config = readDeployment(deployRoot)): DeployIdentity {
  const names = deploymentNames(config);
  return {
    aws: {
      account: config.env.account,
      region: config.env.region,
      cloudFormation: {
        stackFamily: config.name,
      },
      agentCore: {
        runtime: names.runtimeAgentRuntimeName,
        platformVersion: config.agentCore?.runtime?.platformVersion ?? 'V2',
        maxLifetime: config.agentCore?.runtime?.maxLifetime,
        idleRuntimeSessionTimeout: config.agentCore?.runtime?.idleRuntimeSessionTimeout,
        runtimeNetworkParameter: config.existing.browsers?.link
          ? `/${config.name}/agentcore/security-group-id`
          : undefined,
        memory: names.memoryName,
        sessionApiFunction: names.sessionApiFunctionName,
        sessionApiAlias: 'live',
        privateNatBrowser: config.existing.browsers?.link
          ? {
              name: names.linkBrowserName,
              id: config.existing.browsers.link.browserId,
              vpcId: config.existing.vpc.vpcId,
              browserSecurityGroupId: config.existing.browsers.link.securityGroupId,
              extension: {
                bucket: config.agentCore?.browsers?.link?.extension.bucket,
                prefix: config.agentCore?.browsers?.link?.extension.key,
                versionId: config.agentCore?.browsers?.link?.extension.versionId,
              },
              subnets: config.existing.vpc.privateSubnets.map(item => ({
                id: item.subnetId,
                availabilityZone: item.availabilityZone,
                cidrBlock: item.ipv4CidrBlock,
              })),
            }
          : undefined,
        rollbackVersion: config.agentCore?.runtime?.rollbackEndpoint?.agentRuntimeVersion,
      },
      ecr: {
        repository: names.repositoryName,
      },
      codeBuild: {
        project: names.buildProjectName,
      },
      lambda: {
        family: names.buildFunctionName,
      },
      iam: {
        runtimeRole: names.runtimeRoleName,
        memoryRole: names.memoryRoleName,
        userMemoryRole: names.userMemoryRoleName,
        chatServiceTaskRole: config.names?.chatServiceTaskRoleName,
        lambdaRole: names.buildFunctionRoleName,
        codeBuildRole: names.buildRoleName,
        sessionApiRole: names.sessionApiRoleName,
      },
    },
    domains: {
      chatService: config.domains.chatService,
    },
  } as DeployIdentity;
}

export function readProjectSpec(
  deployRoot: string,
  config: DeploymentConfig = readDeployment(deployRoot)
): AgentCoreProjectSpec {
  const name = config.name.replaceAll('-', '_');
  const parsed = AgentCoreProjectSpecSchema.safeParse({
    ...PROJECT_DEFAULTS,
    name: config.name.replaceAll('-', ''),
    tags: { ...PROJECT_DEFAULTS.tags, 'agentcore:project-name': config.name, ...config.tags },
    runtimes: [{ ...RUNTIME_DEFAULTS, name, dockerfile: 'Dockerfile' }],
    memories: [{ ...MEMORY_DEFAULTS, name }],
  });
  if (!parsed.success)
    throw new Error(
      `Invalid AgentCore project from ${path.join(deployRoot, '..', 'botcube.yaml')}: ${parsed.error.message}`
    );
  return parsed.data;
}

/**
 * The directory agentcore-cdk takes as its project: it finds the project by an agentcore/agentcore.json on disk, so
 * the spec is written to a directory of its own. Every path in the spec is absolute, so nothing resolves against it.
 */
export function agentCoreProjectRoot(spec: AgentCoreProjectSpec): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcore-project-'));
  fs.mkdirSync(path.join(root, 'agentcore'));
  fs.writeFileSync(path.join(root, 'agentcore', 'agentcore.json'), JSON.stringify(spec));
  return root;
}

/** Load the active deploy directory's AgentCore project, identity and target, all from the BotCube Config beside it. */
export async function loadDeployConfig(configuredRoot: string | undefined, cwd: string): Promise<DeployConfig> {
  if (!configuredRoot) {
    throw new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory');
  }
  const deployRoot = path.resolve(cwd, configuredRoot);
  const config = readDeployment(deployRoot);
  const identity = readDeployIdentity(deployRoot, config);
  const spec = readProjectSpec(deployRoot, config);
  setSessionProjectRoot(agentCoreProjectRoot(spec));
  const targets = AwsDeploymentTargetsSchema.parse([
    { name: deploymentNames(config).agentCoreTargetName, ...config.env },
  ]);
  const runtimeImage = config.agentCore?.runtime?.containerUri;
  if (!runtimeImage) throw new Error('BotCube Config agentCore.runtime.containerUri must name the published Bot Image');
  const { tags } = config;
  return { deployRoot, identity, spec, targets, runtimeImage, ...(tags ? { tags } : {}) };
}
