import { deployRootFiles, type DeployRootFiles } from 'botcube-config/read';
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

/** What every deploy root's agentcore.json holds unless it says otherwise. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `own` over `defaults`: objects merge key by key, and any other value the deploy root sets replaces the default. */
function overDefaults(defaults: unknown, own: unknown): unknown {
  if (own === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(own)) return own;
  const keys = new Set([...Object.keys(defaults), ...Object.keys(own)]);
  return Object.fromEntries([...keys].map(key => [key, overDefaults(defaults[key], own[key])]));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The deploy root's retired `file`, built from the BotCube Config beside it. */
function readDeployRootFile(deployRoot: string, files: DeployRootFiles, file: string): unknown {
  try {
    return files.file(file);
  } catch (error) {
    throw new Error(
      `Cannot read ${path.join(deployRoot, file)}: ${error instanceof Error ? error.message : String(error)}`
    );
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
      platformVersion: RuntimePlatformVersion;
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

/** The deploy root's identity over BotCube's identity-defaults.json, built from the BotCube Config beside it. */
export function readDeployIdentity(deployRoot: string, files = deployRootFiles(deployRoot)): DeployIdentity {
  return overDefaults(
    readJson(path.join(INFRA, 'identity-defaults.json')),
    readDeployRootFile(deployRoot, files, 'identity.json')
  ) as DeployIdentity;
}

/** The AgentCore project its BotCube Config gives, over the project, runtime and memory defaults every deploy shares. */
export function readProjectSpec(deployRoot: string, files = deployRootFiles(deployRoot)): AgentCoreProjectSpec {
  const specPath = path.join(deployRoot, '..', 'botcube.yaml');
  const own = readDeployRootFile(deployRoot, files, 'agentcore/agentcore.json');
  if (!isRecord(own)) throw new Error(`Invalid AgentCore project from ${specPath}: not a JSON object`);
  const each = (entries: unknown, defaults: object) =>
    Array.isArray(entries) ? entries.map(entry => overDefaults(defaults, entry)) : entries;
  const parsed = AgentCoreProjectSpecSchema.safeParse({
    ...(overDefaults(PROJECT_DEFAULTS, own) as object),
    runtimes: each(own.runtimes, RUNTIME_DEFAULTS),
    memories: each(own.memories, MEMORY_DEFAULTS),
  });
  if (!parsed.success) throw new Error(`Invalid AgentCore project from ${specPath}: ${parsed.error.message}`);
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
  const files = deployRootFiles(deployRoot);
  const identity = readDeployIdentity(deployRoot, files);
  const spec = readProjectSpec(deployRoot, files);
  setSessionProjectRoot(agentCoreProjectRoot(spec));
  const targets = AwsDeploymentTargetsSchema.parse(readDeployRootFile(deployRoot, files, 'agentcore/aws-targets.json'));
  const runtimeImage = files.config.agentCore?.runtime?.containerUri;
  const { tags } = files.config;
  return { deployRoot, identity, spec, targets, ...(runtimeImage ? { runtimeImage } : {}), ...(tags ? { tags } : {}) };
}
