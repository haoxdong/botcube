// The examples' deploy entry (ADR 0091): both BotCube CDK apps, configured from a BotCube Config.
// It reads the seam, so it sits outside this package's `tsc` build, which compiles only what is under it.
import * as path from 'node:path';
import type { App } from 'aws-cdk-lib';
import { commandCredentialOptIn, trustEnvironment } from '../../../../config/environment.js';
import { registryHost } from '../../../../config/images.js';
import { loadConfig } from '../../../../config/load.js';
import { webOrigins } from '../../../../config/read.cjs';
import { modelGatewayResources } from '../../../../config/models.js';
import { outsideIssuer, secretIds } from '../../../../config/credential-fields.js';
import type { BotCubeConfig } from '../../../../config/schema.js';
import { ownEgressVpc } from '../../../../config/suppliable.js';
import { telemetryEnvironment } from '../../../../config/telemetry.js';
import { addAgentCoreStacks } from '../../../agentcore/cdk/lib/agentcore-app.js';
import { loadDeployConfig } from '../../../agentcore/cdk/lib/deploy-config.js';
import { deployIdentity } from '../lib/deploy-root.js';
import type { DeployIdentity } from '../lib/production-identity.js';
import { defineProduction, type ProductionOptions } from '../lib/production.js';
import { grantLambdasInline, placeLambdasInNetwork } from 'botcube-config/lambda-inline-grants';

const EXAMPLE_DEPLOY_ROOT = path.resolve(__dirname, '../../../../examples/public/deploy');
interface ExampleOptions {
  repositoryRoot: string;
  /** The checkout's commit the stacks deploy. */
  commit: string;
  /** The serving stack, from the deploy identity; absent keeps storage and egress only. */
  origin?: (identity: DeployIdentity) => NonNullable<ProductionOptions['origin']>;
  /** Adjusts the deploy identity, as a test's fixture paths do. */
  identity?: (identity: DeployIdentity) => DeployIdentity;
  /** The web latency monitor's metrics reader, which the release tooling that deploys names; absent, none. */
  webLatency?: ProductionOptions['webLatency'];
}

/** Define the deployment the BotCube Config at `configPath` describes, failing on a bad field before any stack. */
export async function defineExample(app: App, configPath: string, options: ExampleOptions): Promise<void> {
  const config = loadConfig(configPath);
  const network = ownEgressVpc(config);
  const configDeployRoot = path.join(path.dirname(path.resolve(configPath)), 'deploy');
  const identity = (options.identity ?? (same => same))(deployIdentity(configDeployRoot));
  const environment = trustEnvironment(config);
  // The operator's opt-in from where the deploy runs, never from the file; it fails here on a command credential without it.
  const commandOptIn = commandCredentialOptIn(config, process.env);
  const telemetry = telemetryEnvironment(config.integrations.telemetry);
  const { kmsKeys, tables, buckets, credentialService } = config.existing;
  const seams = seamWiring(config);
  defineProduction(app, {
    ...seams.production,
    ...(config.tags ? { tags: config.tags } : {}),
    repositoryRoot: options.repositoryRoot, deployRoot: EXAMPLE_DEPLOY_ROOT, identity, config: { path: path.resolve(configPath) }, corsOrigins: webOrigins(config) ?? [], existingNetwork: network !== undefined, imageRegistry: registryHost(config.integrations.imageRegistry),
    origin: options.origin?.(identity),
    ...(options.webLatency ? { webLatency: options.webLatency } : {}),
    storage: { ...(tables?.chat ? { existingChatTable: tables.chat } : {}), ...(config.existing.files ? { existingFiles: config.existing.files } : {}) },
    ...(buckets?.connectionLogs ? { originConfig: { existingConnectionLogsBucketName: buckets.connectionLogs } } : {}),
    chat: {
      ...seams.chat, environment: commandOptIn, trustEnvironment: environment, imageRegistry: registryHost(config.integrations.imageRegistry),
      telemetry: config.integrations.telemetry.kind === 'xray' ? { kind: 'xray' } : { kind: config.integrations.telemetry.kind, environment: telemetry.chatService, secretIds: telemetry.secretIds },
    },
    ...(credentialService ? { existingCredentialEndpoint: credentialService } : {}),
    credentials: {
      environment: { ...environment, ...commandOptIn },
      ...(tables?.vault ? { existingVaultTableName: tables.vault.tableName } : {}),
      ...(kmsKeys?.vault ? { existingVaultKeyArn: kmsKeys.vault } : {}),
      ...(kmsKeys?.sheet ? { existingSheetKeyAlias: kmsKeys.sheet } : {}),
      ...(kmsKeys?.functions ? { existingFunctionsKeyArn: kmsKeys.functions } : {}),
    },
  });
  const agentCore = await loadDeployConfig(configDeployRoot, process.cwd());
  addAgentCoreStacks(app, agentCore, options.commit, {
    ...seams.agentCore,
    botcubeConfigPath: path.resolve(configPath),
    imageRegistry: registryHost(config.integrations.imageRegistry),
    runtimeEnvironment: { ...environment, ...telemetry.harness, ...commandOptIn },
    telemetry: { kind: config.integrations.telemetry.kind, secretIds: telemetry.secretIds },
    ...(kmsKeys?.images ? { existingImageKeyArn: kmsKeys.images } : {}),
  }, config.integrations.awsAccess.kind);
  if (network) placeLambdasInNetwork(app, { vpcId: network.vpcId, privateSubnetIds: network.privateSubnets.map(({ subnetId }) => subnetId) });
  grantLambdasInline(app);
}

/** Each seam's adapter (ADR 0091) as the two CDK apps take it: models, Harness auth, schedules, Turn credentials, identity. */
function seamWiring(config: BotCubeConfig) {
  const models = modelGatewayResources(config.integrations.modelGateway);
  return {
    production: {
      ...(models ? { models } : {}),
      awsAccess: config.integrations.awsAccess.kind,
      chatSecretIds: secretIds(
        ...(config.integrations.signIn.kind === 'oidc' ? config.integrations.signIn.clients.map(({ clientSecret }) => clientSecret) : []),
        ...(outsideIssuer(config.integrations.harnessAuth) ? [config.integrations.harnessAuth.token] : []),
      ),
    } satisfies Partial<ProductionOptions>,
    chat: { harnessAuth: config.integrations.harnessAuth, schedules: config.schedules.kind, liveView: config.liveView.kind } satisfies ProductionOptions['chat'],
    agentCore: { ...(models ? { models } : {}), harnessAuth: config.integrations.harnessAuth },
  };
}
