import { ok as assert } from 'node:assert';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
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
import type { RuntimeNetwork } from './runtime-network';
import type { RuntimePlatformVersion } from './runtime-platform';

const manifest = findPackageJSON('.', pathToFileURL(__filename));
assert(manifest, 'The AgentCore CDK module must be inside its package');

const PROJECT_DEFAULTS = { version: 1, managedBy: 'CDK', tags: { 'agentcore:created-by': 'agentcore-cli' } };
const RUNTIME_DEFAULTS = {
  build: 'Container',
  entrypoint: 'src/botcube_harness_deepagents/serving.py',
  // Every deploy runs BotCube's Harness, beside this infra.
  codeLocation: path.resolve(path.dirname(manifest), '../../../harness/deepagents'),
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

export interface DeployIdentity {
  aws: {
    account: string;
    region: string;
    cloudFormation: { stackFamily: string };
    agentCore: {
      runtime: string;
      memory: string;
      sessionApiFunction: string;
      platformVersion: RuntimePlatformVersion;
      maxLifetime?: number;
      idleRuntimeSessionTimeout?: number;
      rollbackVersion?: string;
      runtimeNetwork?: RuntimeNetwork | undefined;
    };
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
  botcubeConfigPath?: string;
  connectors?: DeploymentConfig['connectors'];
  signIn?: NonNullable<DeploymentConfig['integrations']>['signIn'];
  identity: DeployIdentity;
  spec: AgentCoreProjectSpec;
  targets: AwsDeploymentTarget[];
  /** The Bot Image the Runtime runs, the BotCube Config's `agentCore.runtime.containerUri`; absent, it is built. */
  runtimeImage?: string;
  existingMemoryKeyArn?: string;
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
        memory: names.memoryName,
        sessionApiFunction: names.sessionApiFunctionName,
        runtimeNetwork: config.existing.browsers?.link
          ? {
              securityGroupParameterName: `/${config.name}/agentcore/security-group-id`,
              subnetIds: config.existing.vpc.privateSubnets.map(subnet => subnet.subnetId),
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
  if (config.integrations?.connectorGateway) {
    throw new Error('The AgentCore deploy fills integrations.connectorGateway');
  }
  const identity = readDeployIdentity(deployRoot, config);
  const spec = readProjectSpec(deployRoot, config);
  setSessionProjectRoot(agentCoreProjectRoot(spec));
  const targets = AwsDeploymentTargetsSchema.parse([
    { name: deploymentNames(config).agentCoreTargetName, ...config.env },
  ]);
  const runtimeImage = config.agentCore?.runtime?.containerUri;
  if (!runtimeImage) throw new Error('BotCube Config agentCore.runtime.containerUri must name the published Bot Image');
  const { tags } = config;
  const existingMemoryKeyArn = config.existing.kmsKeys?.memory;
  return {
    deployRoot,
    botcubeConfigPath: path.resolve(deployRoot, '../botcube.yaml'),
    connectors: config.connectors,
    signIn: config.integrations?.signIn,
    identity,
    spec,
    targets,
    runtimeImage,
    ...(tags ? { tags } : {}),
    ...(existingMemoryKeyArn ? { existingMemoryKeyArn } : {}),
  };
}
