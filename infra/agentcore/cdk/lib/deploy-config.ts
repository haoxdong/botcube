import {
  AgentCoreProjectSpecSchema,
  ConfigIO,
  setSessionProjectRoot,
  type AgentCoreProjectSpec,
  type AwsDeploymentTarget,
} from '@aws/agentcore-cdk';
import * as fs from 'fs';
import * as path from 'path';

/** This project's directory holds cdk.json, whether the app runs from source or from dist/. */
function projectDir(dir: string): string {
  if (fs.existsSync(path.join(dir, 'cdk.json'))) return dir;
  if (path.dirname(dir) === dir) throw new Error('The AgentCore CDK app has no cdk.json above it');
  return projectDir(path.dirname(dir));
}
const INFRA = path.resolve(projectDir(__dirname), '../..');

/** What every Cartridge's agentcore.json holds unless it says otherwise. */
const PROJECT_DEFAULTS = { version: 1, managedBy: 'CDK', tags: { 'agentcore:created-by': 'agentcore-cli' } };
const RUNTIME_DEFAULTS = {
  build: 'Container',
  entrypoint: 'src/botcube_harness_deepagents/serving.py',
  // Every Cartridge runs BotCube's Harness, beside this infra.
  codeLocation: path.resolve(INFRA, '../harness/deepagents'),
  runtimeVersion: 'PYTHON_3_13',
  networkMode: 'PUBLIC',
  protocol: 'AGUI',
  envVars: [
    { name: 'AGENT_OBSERVABILITY_ENABLED', value: 'true' },
    { name: 'OTEL_PYTHON_DISTRO', value: 'aws_distro' },
    { name: 'OTEL_PYTHON_CONFIGURATOR', value: 'aws_configurator' },
    { name: 'OTEL_TRACES_SAMPLER', value: 'always_on' },
    { name: 'TRACELOOP_TRACE_CONTENT', value: 'false' },
    { name: 'UNIFIED_TRACES_DESTINATION_ENABLED', value: 'false' },
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `cartridge` over `defaults`: objects merge key by key, and any other value the Cartridge sets replaces the default. */
function overDefaults(defaults: unknown, cartridge: unknown): unknown {
  if (cartridge === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(cartridge)) return cartridge;
  const keys = new Set([...Object.keys(defaults), ...Object.keys(cartridge)]);
  return Object.fromEntries([...keys].map(key => [key, overDefaults(defaults[key], cartridge[key])]));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
      /** The role a Turn's JWT turns into Memory credentials for one user (ADR 0067 §8). */
      userMemoryRole: string;
      lambdaRole: string;
      codeBuildRole: string;
      sessionApiRole: string;
    };
  };
  /** The Chat Service's origin: its hostname, over https, issues the per-Turn JWT. */
  domains: { chatService: string };
  artifacts: { toolStaging: { hook: string } };
}

export interface DeployConfig {
  deployRoot: string;
  identity: DeployIdentity;
  spec: AgentCoreProjectSpec;
  targets: AwsDeploymentTarget[];
}

/** The Cartridge's identity.json over BotCube's identity-defaults.json. */
export function readDeployIdentity(deployRoot: string): DeployIdentity {
  const identityPath = path.join(deployRoot, 'identity.json');
  const identity = overDefaults(readJson(path.join(INFRA, 'identity-defaults.json')), readJson(identityPath)) as {
    aws?: Partial<DeployIdentity['aws']>;
  };
  // identity.json is operator input: check the fields it must carry before trusting its shape.
  if (!identity.aws?.account || !identity.aws.region) {
    throw new Error(`Invalid Cartridge deploy identity at ${identityPath}`);
  }
  return identity as DeployIdentity;
}

/** The Cartridge's agentcore.json over the project, runtime and memory defaults every Cartridge shares. */
export function readProjectSpec(deployRoot: string): AgentCoreProjectSpec {
  const specPath = path.join(deployRoot, 'agentcore', 'agentcore.json');
  const cartridge = readJson(specPath);
  if (!isRecord(cartridge)) throw new Error(`Invalid AgentCore config at ${specPath}: not a JSON object`);
  const each = (entries: unknown, defaults: object) =>
    Array.isArray(entries) ? entries.map(entry => overDefaults(defaults, entry)) : entries;
  const parsed = AgentCoreProjectSpecSchema.safeParse({
    ...(overDefaults(PROJECT_DEFAULTS, cartridge) as object),
    runtimes: each(cartridge.runtimes, RUNTIME_DEFAULTS),
    memories: each(cartridge.memories, MEMORY_DEFAULTS),
  });
  if (!parsed.success) throw new Error(`Invalid AgentCore config at ${specPath}: ${parsed.error.message}`);
  return parsed.data;
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
  const spec = readProjectSpec(deployRoot);
  const targets = await new ConfigIO({ baseDir: configRoot }).readAWSDeploymentTargets();

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
