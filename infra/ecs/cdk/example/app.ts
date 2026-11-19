// The examples' deploy entry (ADR 0091): both BotCube CDK apps, configured from a Deployment Config.
// It reads the seam, so it sits outside this package's `tsc` build, which compiles only what is under it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from 'aws-cdk-lib';
import { commandCredentialOptIn, proxyEnvironment } from '../../../../deployment-config/environment.js';
import { loadDeployment } from '../../../../deployment-config/load.js';
import { modelsDeployment } from '../../../../deployment-config/models.js';
import { outsideIssuer, secretArns } from '../../../../deployment-config/credential-fields.js';
import type { DeploymentConfig } from '../../../../deployment-config/schema.js';
import { telemetryDeployment } from '../../../../deployment-config/telemetry.js';
import { addAgentCoreStacks } from '../../../agentcore/cdk/lib/agentcore-app.js';
import { loadDeployConfig } from '../../../agentcore/cdk/lib/deploy-config.js';
import { cartridgeIdentity } from '../lib/cartridge.js';
import type { DeployIdentity } from '../lib/production-identity.js';
import { defineProduction, type ProductionOptions } from '../lib/production.js';
import { placeLambdasInNetwork } from '../lib/supplied-network.js';

/** The examples' deploy names and AgentCore spec, still in the Always On deploy directory until it moves under them. */
const EXAMPLE_DEPLOY_ROOT = path.resolve(__dirname, '../../../../templates/always-on/deploy');
/** The examples' chat image, and the examples directory whose files it ships under its WORKDIR. */
const CHAT_DOCKERFILE = path.resolve(__dirname, '../../../../chat/Dockerfile');
export const EXAMPLES_ROOT = path.resolve(__dirname, '../../../../examples');
export const IMAGE_EXAMPLES_ROOT = '/opt/chat-service/examples';

const EXAMPLE_IDENTITIES: Readonly<Partial<Record<string, (identity: DeployIdentity) => DeployIdentity>>> = {
  'enterprise/deployment-config.json': ({ aws: { ecs: { privateEgress: _, ...ecs }, ...aws }, ...identity }) => ({ ...identity, aws: { ...aws, ecs } }),
};

interface ExampleOptions {
  repositoryRoot: string;
  /** The checkout's commit the stacks deploy. */
  commit: string;
  /** The serving stack, from the deploy identity; absent keeps storage and egress only. */
  origin?: (identity: DeployIdentity) => NonNullable<ProductionOptions['origin']>;
  /** Adjusts the deploy identity, as a test's fixture paths do. */
  identity?: (identity: DeployIdentity) => DeployIdentity;
}

/** Define the deployment the Deployment Config at `configPath` describes, failing on a bad field before any stack. */
export async function defineExample(app: App, configPath: string, options: ExampleOptions): Promise<void> {
  const { config } = loadDeployment(configPath);
  const deploymentConfig = imageDeploymentConfig(configPath, config.bot);
  const network = config.supplied?.network;
  const exampleIdentity = EXAMPLE_IDENTITIES[path.relative(EXAMPLES_ROOT, path.resolve(configPath)).split(path.sep).join('/')] ?? (same => same);
  const identity = inNetwork((options.identity ?? (same => same))(exampleIdentity(cartridgeIdentity(EXAMPLE_DEPLOY_ROOT))), network);
  const environment = proxyEnvironment(config);
  // The operator's opt-in from where the deploy runs, never from the file; it fails here on a command credential without it.
  const commandOptIn = commandCredentialOptIn(config, process.env);
  const telemetry = telemetryDeployment(config.telemetry);
  const { kmsKeys, tables, buckets } = config.supplied ?? {};
  const seams = seamWiring(config);
  defineProduction(app, {
    ...seams.production,
    repositoryRoot: options.repositoryRoot, deployRoot: EXAMPLE_DEPLOY_ROOT, identity, suppliedNetwork: network !== undefined, imageRegistry: config.imageRegistry,
    origin: options.origin?.(identity),
    ...(tables?.chat ? { storage: { suppliedChatTable: tables.chat } } : {}),
    ...(buckets?.connectionLogs ? { originConfig: { suppliedConnectionLogsBucketName: buckets.connectionLogs } } : {}),
    chat: {
      ...seams.chat, deploymentConfig, environment: commandOptIn, proxyEnvironment: environment, imageRegistry: config.imageRegistry,
      telemetry: config.telemetry.kind === 'xray' ? { kind: 'xray' } : { kind: config.telemetry.kind, environment: telemetry.chatService, secretArns: telemetry.secretArns },
    },
    credentials: {
      environment: proxyEnvironment(config),
      ...(tables?.vault ? { suppliedVaultTableName: tables.vault.tableName } : {}),
      ...(kmsKeys?.vault ? { suppliedVaultKeyArn: kmsKeys.vault } : {}),
      ...(kmsKeys?.sheet ? { suppliedSheetKeyArn: kmsKeys.sheet } : {}),
    },
  });
  const agentCore = await loadDeployConfig(EXAMPLE_DEPLOY_ROOT, process.cwd());
  addAgentCoreStacks(app, { ...agentCore, identity: inNetwork(agentCore.identity, network) }, options.commit, {
    ...seams.agentCore,
    imageRegistry: config.imageRegistry,
    runtimeEnvironment: { ...environment, ...telemetry.harness, ...commandOptIn },
    telemetry: { kind: config.telemetry.kind, secretArns: telemetry.secretArns },
    ...(kmsKeys?.memory ? { suppliedMemoryKeyArn: kmsKeys.memory } : {}),
    ...(kmsKeys?.images ? { suppliedImageKeyArn: kmsKeys.images } : {}),
  }, config.turnCredentials.kind);
  if (network) placeLambdasInNetwork(app, { vpcId: network.vpcId, privateSubnetIds: network.privateSubnets.map(({ subnetId }) => subnetId) });
}

/**
 * Where the chat image holds this Deployment Config, so the Chat Service serves what its infrastructure was built from.
 * The image ships only the files under botcube/examples/ its Dockerfile copies, each at the same path under
 * IMAGE_EXAMPLES_ROOT, so the config's relative `bot` path still resolves; any other config fails here.
 */
function imageDeploymentConfig(configPath: string, bot: string): string {
  const shipped = new Set(fs.readFileSync(CHAT_DOCKERFILE, 'utf8').split('\n')
    .filter(line => /^COPY\s/.test(line) && !line.includes('--from='))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1))
    .filter(source => source.startsWith('${BOTCUBE_ROOT}/examples/'))
    .map(source => source.slice('${BOTCUBE_ROOT}/examples/'.length)));
  const config = path.relative(EXAMPLES_ROOT, path.resolve(configPath));
  const settings = path.relative(EXAMPLES_ROOT, path.resolve(path.dirname(configPath), bot));
  for (const file of [config, settings]) {
    if (!file || !shipped.has(file.split(path.sep).join('/'))) {
      throw new Error(`Deployment Config ${configPath}: the chat image ships only ${[...shipped].join(', ')} under ${EXAMPLES_ROOT}, not ${path.resolve(EXAMPLES_ROOT, file)}; copy it in ${CHAT_DOCKERFILE}`);
    }
  }
  return path.posix.join(IMAGE_EXAMPLES_ROOT, config.split(path.sep).join('/'));
}

/** Each seam's adapter (ADR 0091) as the two CDK apps take it: models, Harness auth, schedules, Turn credentials, identity. */
function seamWiring(config: DeploymentConfig) {
  const models = modelsDeployment(config.models);
  return {
    production: {
      ...(models ? { models } : {}),
      turnCredentials: config.turnCredentials.kind,
      chatSecretArns: secretArns(
        ...(config.identity.kind === 'oidc' ? config.identity.clients.map(({ clientSecret }) => clientSecret) : []),
        ...(outsideIssuer(config.harnessAuth) ? [config.harnessAuth.token] : []),
      ),
    } satisfies Partial<ProductionOptions>,
    chat: { harnessAuth: config.harnessAuth, schedules: config.schedules.kind, liveView: config.liveView.kind } satisfies ProductionOptions['chat'],
    agentCore: { ...(models ? { models } : {}), harnessAuth: config.harnessAuth },
  };
}

type Network = NonNullable<NonNullable<DeploymentConfig['supplied']>['network']>;
interface NetworkIdentity {
  aws: { agentCore: { privateNatBrowser?: { subnets: { id: string; availabilityZone: string }[] } }; credentialService?: { vpcId: string }; ecs?: { publicSubnets: unknown[] } };
}

/**
 * The identity with its VPC and subnets replaced by the supplied network's: the origin load balancer in its public
 * subnets; the services, browsers and Runtime in its private ones.
 */
function inNetwork<Identity extends NetworkIdentity>(identity: Identity, network: Network | undefined): Identity {
  if (!network) return identity;
  const subnets = network.privateSubnets.map(({ subnetId, availabilityZone, cidrBlock }) => ({ id: subnetId, availabilityZone, cidrBlock }));
  const { aws } = identity;
  return {
    ...identity,
    aws: {
      ...aws,
      agentCore: { ...aws.agentCore, ...(aws.agentCore.privateNatBrowser ? { privateNatBrowser: { ...aws.agentCore.privateNatBrowser, vpcId: network.vpcId, subnets } } : {}) },
      ...(aws.credentialService ? { credentialService: { ...aws.credentialService, vpcId: network.vpcId } } : {}),
      ...(aws.ecs ? { ecs: { ...aws.ecs, publicSubnets: network.publicSubnets.map(({ subnetId, availabilityZone }) => ({ id: subnetId, availabilityZone })) } } : {}),
    },
  };
}
