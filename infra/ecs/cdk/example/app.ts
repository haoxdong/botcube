// The examples' deploy entry (ADR 0091): both BotCube CDK apps, configured from a BotCube Config.
// It reads the seam, so it sits outside this package's `tsc` build, which compiles only what is under it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from 'aws-cdk-lib';
import { commandCredentialOptIn, proxyEnvironment } from '../../../../config/environment.js';
import { loadConfig } from '../../../../config/load.js';
import { modelGatewayResources } from '../../../../config/models.js';
import { outsideIssuer, secretArns } from '../../../../config/credential-fields.js';
import type { BotCubeConfig } from '../../../../config/schema.js';
import { telemetryEnvironment } from '../../../../config/telemetry.js';
import { addAgentCoreStacks } from '../../../agentcore/cdk/lib/agentcore-app.js';
import { loadDeployConfig } from '../../../agentcore/cdk/lib/deploy-config.js';
import { deployIdentity } from '../lib/deploy-root.js';
import type { DeployIdentity } from '../lib/production-identity.js';
import { defineProduction, type ProductionOptions } from '../lib/production.js';
import { grantLambdasInline } from '../lib/lambda-inline-grants.js';
import { placeLambdasInNetwork } from '../lib/existing-network.js';

/** The examples' deploy names and AgentCore spec, in the public example's deploy directory. */
const EXAMPLE_DEPLOY_ROOT = path.resolve(__dirname, '../../../../examples/public/deploy');
export const EXAMPLES_ROOT = path.resolve(__dirname, '../../../../examples');
export const IMAGE_EXAMPLES_ROOT = '/opt/chat-service/examples';
export const CREDENTIAL_IMAGE_EXAMPLES_ROOT = '/opt/botcube/examples';

/** An image the examples deploy: its Dockerfile, the prefix its COPY sources under botcube/examples/ carry, and where it ships them. */
interface ExampleImage {
  name: string;
  dockerfile: string;
  sources: string;
  root: string;
}

const CHAT_IMAGE: ExampleImage = {
  name: 'chat', dockerfile: path.resolve(__dirname, '../../../../chat/Dockerfile'), sources: '${BOTCUBE_ROOT}/examples/', root: IMAGE_EXAMPLES_ROOT,
};
const CREDENTIAL_IMAGE: ExampleImage = {
  name: 'Credential Service', dockerfile: path.resolve(__dirname, '../../../../credential-service/Dockerfile'),
  sources: '${BOTCUBE_ROOT}/examples/', root: CREDENTIAL_IMAGE_EXAMPLES_ROOT,
};
/** The Runtime image, whose COPYs public/deploy/stage-tools.sh writes into the Harness build context's .tool-dist/Dockerfile. */
const RUNTIME_IMAGE: ExampleImage = {
  name: 'Runtime', dockerfile: path.resolve(EXAMPLE_DEPLOY_ROOT, 'stage-tools.sh'), sources: '.tool-dist/examples/', root: CREDENTIAL_IMAGE_EXAMPLES_ROOT,
};

const EXAMPLE_IDENTITIES: Readonly<Partial<Record<string, (identity: DeployIdentity) => DeployIdentity>>> = {
  'enterprise/botcube.yaml': ({ aws: { ecs: { privateEgress: _, ...ecs }, ...aws }, ...identity }) => ({ ...identity, aws: { ...aws, ecs } }),
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

/** Define the deployment the BotCube Config at `configPath` describes, failing on a bad field before any stack. */
export async function defineExample(app: App, configPath: string, options: ExampleOptions): Promise<void> {
  const config = loadConfig(configPath);
  const botcubeConfig = imageBotCubeConfig(CHAT_IMAGE, configPath, []);
  const credentialBotCubeConfig = imageBotCubeConfig(CREDENTIAL_IMAGE, configPath, []);
  const runtimeBotCubeConfig = imageBotCubeConfig(RUNTIME_IMAGE, configPath, []);
  const network = config.existing?.network;
  const exampleIdentity = EXAMPLE_IDENTITIES[path.relative(EXAMPLES_ROOT, path.resolve(configPath)).split(path.sep).join('/')] ?? (same => same);
  const identity = inNetwork((options.identity ?? (same => same))(exampleIdentity(deployIdentity(EXAMPLE_DEPLOY_ROOT))), network);
  const environment = proxyEnvironment(config);
  // The operator's opt-in from where the deploy runs, never from the file; it fails here on a command credential without it.
  const commandOptIn = commandCredentialOptIn(config, process.env);
  const telemetry = telemetryEnvironment(config.integrations.telemetry);
  const { kmsKeys, tables, buckets, credentialService } = config.existing ?? {};
  const seams = seamWiring(config);
  defineProduction(app, {
    ...seams.production,
    repositoryRoot: options.repositoryRoot, deployRoot: EXAMPLE_DEPLOY_ROOT, identity, corsOrigins: config.network.corsOrigins ?? [], existingNetwork: network !== undefined, imageRegistry: config.integrations.imageRegistry,
    origin: options.origin?.(identity),
    storage: { ...(tables?.chat ? { existingChatTable: tables.chat } : {}), ...(config.existing?.files ? { existingFiles: config.existing.files } : {}) },
    ...(buckets?.connectionLogs ? { originConfig: { existingConnectionLogsBucketName: buckets.connectionLogs } } : {}),
    chat: {
      ...seams.chat, botcubeConfig, environment: commandOptIn, proxyEnvironment: environment, imageRegistry: config.integrations.imageRegistry,
      telemetry: config.integrations.telemetry.kind === 'xray' ? { kind: 'xray' } : { kind: config.integrations.telemetry.kind, environment: telemetry.chatService, secretArns: telemetry.secretArns },
    },
    credentials: {
      environment: { ...environment, ...commandOptIn, BOTCUBE_CONFIG: credentialBotCubeConfig },
      ...(tables?.vault ? { existingVaultTableName: tables.vault.tableName } : {}),
      ...(kmsKeys?.vault ? { existingVaultKeyArn: kmsKeys.vault } : {}),
      ...(kmsKeys?.sheet ? { existingSheetKeyAlias: kmsKeys.sheet } : {}),
      ...(kmsKeys?.functions ? { existingFunctionsKeyArn: kmsKeys.functions } : {}),
      ...(credentialService ? { existingEndpoint: credentialService } : {}),
    },
  });
  const agentCore = await loadDeployConfig(EXAMPLE_DEPLOY_ROOT, process.cwd());
  addAgentCoreStacks(app, { ...agentCore, identity: inNetwork(agentCore.identity, network) }, options.commit, {
    ...seams.agentCore,
    imageRegistry: config.integrations.imageRegistry,
    runtimeEnvironment: { ...environment, ...telemetry.harness, ...commandOptIn, BOTCUBE_CONFIG: runtimeBotCubeConfig },
    telemetry: { kind: config.integrations.telemetry.kind, secretArns: telemetry.secretArns },
    ...(kmsKeys?.memory ? { existingMemoryKeyArn: kmsKeys.memory } : {}),
    ...(kmsKeys?.images ? { existingImageKeyArn: kmsKeys.images } : {}),
  }, config.integrations.awsAccess.kind);
  if (network) placeLambdasInNetwork(app, { vpcId: network.vpcId, privateSubnetIds: network.privateSubnets.map(({ subnetId }) => subnetId) });
  grantLambdasInline(app);
}

/**
 * Where the image holds this BotCube Config, so each process serves what its infrastructure was built from. The
 * image ships only the files under botcube/examples/ its Dockerfile copies, each at the same path under its root, so
 * the config's relative paths it reads (`bot` for the chat image) still resolve; any other config fails here.
 */
function imageBotCubeConfig({ name, dockerfile, sources, root }: ExampleImage, configPath: string, beside: readonly string[]): string {
  const shipped = new Set(fs.readFileSync(dockerfile, 'utf8').split('\n')
    .filter(line => /^COPY\s/.test(line) && !line.includes('--from='))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1))
    .filter(source => source.startsWith(sources))
    .map(source => source.slice(sources.length)));
  const config = path.relative(EXAMPLES_ROOT, path.resolve(configPath));
  const files = beside.map(file => path.relative(EXAMPLES_ROOT, path.resolve(path.dirname(configPath), file)));
  for (const file of [config, ...files]) {
    if (!file || !shipped.has(file.split(path.sep).join('/'))) {
      throw new Error(`BotCube Config ${configPath}: the ${name} image ships only ${[...shipped].join(', ')} under ${EXAMPLES_ROOT}, not ${path.resolve(EXAMPLES_ROOT, file)}; copy it in ${dockerfile}`);
    }
  }
  return path.posix.join(root, config.split(path.sep).join('/'));
}

/** Each seam's adapter (ADR 0091) as the two CDK apps take it: models, Harness auth, schedules, Turn credentials, identity. */
function seamWiring(config: BotCubeConfig) {
  const models = modelGatewayResources(config.integrations.modelGateway);
  return {
    production: {
      ...(models ? { models } : {}),
      awsAccess: config.integrations.awsAccess.kind,
      chatSecretArns: secretArns(
        ...(config.integrations.signIn.kind === 'oidc' ? config.integrations.signIn.clients.map(({ clientSecret }) => clientSecret) : []),
        ...(outsideIssuer(config.integrations.harnessAuth) ? [config.integrations.harnessAuth.token] : []),
      ),
    } satisfies Partial<ProductionOptions>,
    chat: { harnessAuth: config.integrations.harnessAuth, schedules: config.schedules.kind, liveView: config.liveView.kind } satisfies ProductionOptions['chat'],
    agentCore: { ...(models ? { models } : {}), harnessAuth: config.integrations.harnessAuth },
  };
}

type Network = NonNullable<NonNullable<BotCubeConfig['existing']>['network']>;
interface NetworkIdentity {
  aws: { agentCore: { privateNatBrowser?: { subnets: { id: string; availabilityZone: string }[] } }; credentialService?: { vpcId: string }; ecs?: { publicSubnets: unknown[] } };
}

/**
 * The identity with its VPC and subnets replaced by the existing network's: the origin load balancer in its public
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
