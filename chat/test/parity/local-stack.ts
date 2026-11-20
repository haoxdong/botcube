import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { required } from '../required.js';
import { Browser } from './browser.js';
import { loadDeployment } from '../../../deployment-config/load.js';
import { modelsDeployment } from '../../../deployment-config/models.js';
import { proxyEnvironment } from '../../../deployment-config/environment.js';
import { telemetryDeployment } from '../../../deployment-config/telemetry.js';
import { FakeBedrock, FakeOpenAICompatible } from '../fakes/fake-backends.js';
import { FakeForwardProxy, FakeOtlpCollector } from '../fakes/egress.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../fakes/stack.js';
import { freePort, startOnFreePort, startProcess, type RunningProcess } from '../fakes/process.js';
import { createScheduledRuns, SchedulerView } from '../fakes/scheduler.js';
import { motoEndpoint } from '../fakes/moto.js';
import { FakeJwtAuthorizer } from '../fakes/jwt-authorizer.js';
import type { DeploymentConfig } from '../../../deployment-config/schema.js';

/** The Chat Service's public origin, the issuer of its tokens; the Harness's authorizer reaches it at its local address. */
export const PUBLIC_ORIGIN = 'https://chat.example.test';

/**
 * The Harness's Python environment. The Harness and its session API start from their console scripts' entry points,
 * as the Harness image does, so each module runs under its own name rather than as `__main__`.
 */
export const HARNESS_BIN = fileURLToPath(new URL('../../../harness/deepagents/.venv/bin', import.meta.url));

/** The Credential Service's own Python environment, for the fixtures that compose a Credential Service. */
export const CREDENTIAL_SERVICE_BIN = fileURLToPath(new URL('../../../credential-service/.venv/bin', import.meta.url));

/** The parity fixtures, run by path: the fake site, its CLI, its Credential Service provider and its Harness definition. */
export const FIXTURES = fileURLToPath(new URL('fixtures', import.meta.url));

const HARNESS_COMMAND =
  `${HARNESS_BIN}/python -c "from botcube_harness_deepagents import llm, serving; ` +
  `llm.AVAILABLE_MODELS.update(dict.fromkeys(llm.AVAILABLE_MODELS, 'echo')); serving.main()"`;

const EXAMPLE_BOT = fileURLToPath(new URL('../../../examples/bot/bot.json', import.meta.url));

/** The stock Chat Service, as its image runs it. */
const CHAT_SERVICE_COMMAND = `node ${fileURLToPath(new URL('../../dist/main.js', import.meta.url))}`;

/** The Deployment Config the stack deploys unless given one: the public example's. */
const PUBLIC_EXAMPLE = fileURLToPath(new URL('../../../examples/public/deployment-config.json', import.meta.url));

export interface LocalStack {
  readonly url: string;
  /** The Bedrock Converse endpoint each finished Turn is summarized at. */
  readonly bedrock: FakeBedrock;
  /** The stand-in for a Deployment Config's OpenAI-compatible models endpoint, when it names one. */
  readonly openAICompatible?: FakeOpenAICompatible;
  readonly scheduler?: SchedulerView;
  /** The Harness as the Chat Service reaches it: behind the Runtime's JWT authorizer when the Harness auth is a bearer. */
  readonly harnessUrl: string;
  /** The stand-ins for a Deployment Config's proxy and traces collector, when it names a proxy. */
  readonly egress: EgressStandIns | undefined;
  browser(): Browser;
  logs(): string;
  stop(): Promise<void>;
  restartHarness(): Promise<void>;
}

/**
 * The Chat Service against the real local Harness (echo model) and session
 * API, sharing one SQLite checkpoint file, with moto for Session Metadata and a fake
 * summary model: the local-development stack, with no AWS.
 */
export async function startLocalStack(options: {
  harnessCommand?: string;
  chatServiceCommand?: string;
  harnessEnv?: NodeJS.ProcessEnv;
  chatEnv?: NodeJS.ProcessEnv;
  scheduling?: boolean;
  /** The Deployment Config the stack deploys, its External Services replaced by their offline stand-ins; the public example's unless given. */
  deploymentConfig?: string;
} = {}): Promise<LocalStack> {
  const dynamodbEndpoint = motoEndpoint();
  // Startup stops on a bad Deployment Config before any process starts, naming the field, as the Chat Service's does.
  const deploymentPath = options.deploymentConfig ?? options.chatEnv?.BOTCUBE_DEPLOYMENT_CONFIG ?? PUBLIC_EXAMPLE;
  const deployment = loadDeployment(deploymentPath);
  const home = await mkdtemp('/tmp/bc-');
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(dynamodbEndpoint, table);
  // The table poller needs its run queue to start, as the CDK always gives it one (`scheduled-runs.ts` in botcube/infra/ecs/cdk).
  const scheduledRuns = options.scheduling || deployment.config.schedules.kind === 'table-poller' ? await createScheduledRuns(dynamodbEndpoint) : undefined;
  const pythonEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AGENTCORE_MEMORY_ID: '',
    LANGSMITH_TRACING: 'false',
    BOTCUBE_MODEL: 'echo',
    BOTCUBE_CHECKPOINT_PATH: join(home, 'checkpoints.sqlite3'),
    // The example bot's image, unbuilt: BotCube's Harness serving the bot's settings and skills.
    BOTCUBE_BOT_SETTINGS: EXAMPLE_BOT,
    // A start that never answers dumps its stacks (botcube/chat/test/fakes/process.ts).
    PYTHONFAULTHANDLER: '1',
    // The Mutation Gate's tier 2 (ADR 0069) activates a Mutant in the service through these:
    // mutmut's active Mutant, and the path to its mutated copy of the code. Unset otherwise.
    MUTANT_UNDER_TEST: process.env.MUTANT_UNDER_TEST,
    PYTHONPATH: process.env.PYTHONPATH,
    ...options.harnessEnv,
  };
  const processes: RunningProcess[] = [];
  const bedrock = await new FakeBedrock().listen();
  const models = deployment.config.models;
  const openAICompatible = models.kind === 'openai-compatible' ? await new FakeOpenAICompatible(`sk-${table}`).listen() : undefined;
  const harnessAuth = deployment.config.harnessAuth;
  const egress = await egressStandIns(deployment.config, home);
  let authorizer: FakeJwtAuthorizer | undefined;
  const stopAll = async () => {
    await Promise.all([...processes.map((running) => running.stop()), bedrock.close(), openAICompatible?.close(), authorizer?.close(), egress?.proxy.close(), egress?.collector?.close()]);
    await rm(home, { recursive: true, force: true });
  };
  try {
    // Every process reads the one Deployment Config, its External Services replaced by their offline stand-ins.
    const deploymentConfig = await standInDeploymentConfig(deploymentPath, deployment.config, home, egress?.offline);
    // The models Endpoint's stand-in, its API key in a file as a secret injector mounts it, for the Chat Service's Turn
    // Summary and the Credential Service the Harness relays through; the Endpoint's headers are the Deployment Config's own.
    // It stays in the environment: the stand-in is http on loopback, which models.url (https only) refuses.
    const modelsEnv = openAICompatible && models.kind === 'openai-compatible'
      ? modelsDeployment({ ...models, url: `${openAICompatible.url}/v1`, credential: { kind: 'file', path: await keyFile(home, openAICompatible.apiKey) } })
      : undefined;
    Object.assign(pythonEnv, egress?.environment, { BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig }, options.harnessEnv);
    const start = async (command: string, env: NodeJS.ProcessEnv, path: string, listeningPrefix: string) => {
      const running = await startOnFreePort((port) => ({
        command,
        env: { ...env, PORT: String(port) },
        url: `http://127.0.0.1:${port}${path}`,
        listening: `${listeningPrefix}${port}`,
      }));
      processes.push(running);
      return new URL(running.url).origin;
    };
    const credentialService = modelsEnv && {
      BOTCUBE_CREDENTIAL_SERVICE_URL: await start(
        `${CREDENTIAL_SERVICE_BIN}/python ${fileURLToPath(new URL('models-credential-service.py', import.meta.url))}`,
        {
          PATH: process.env.PATH,
          HOME: home,
          BOTCUBE_CREDENTIAL_INVOCATION_SECRET: MODELS_INVOCATION_SECRET,
          BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig,
          ...modelsEnv.credentialService,
        },
        '/health',
        'Uvicorn running on http://127.0.0.1:',
      ),
      BOTCUBE_CREDENTIAL_INVOCATION_SECRET: MODELS_INVOCATION_SECRET,
    };
    let harnessProcess: RunningProcess | undefined;
    let harnessOptions: Parameters<typeof startProcess>[0] | undefined;
    const [harness, sessionApi] = await Promise.all([
      startOnFreePort((port) => {
        harnessOptions = { command: options.harnessCommand ?? HARNESS_COMMAND, env: { ...pythonEnv, PORT: String(port) }, url: `http://127.0.0.1:${port}/ping`, listening: `Uvicorn running on http://0.0.0.0:${port}` };
        return harnessOptions;
      }).then((running) => { harnessProcess = running; processes.push(running); return new URL(running.url).origin; }),
      start(`${HARNESS_BIN}/botcube-session-api`, pythonEnv, '/ping', 'Uvicorn running on http://0.0.0.0:'),
    ]);
    if (harnessAuth.kind === 'jwt-bearer') authorizer = await new FakeJwtAuthorizer(harness, harnessAuth.clients.map(({ clientId }) => clientId)).listen();
    const harnessUrl = authorizer?.url ?? harness;
    const url = await start(
      options.chatServiceCommand ?? CHAT_SERVICE_COMMAND,
      {
        PATH: process.env.PATH,
        HOME: home,
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        // The SDK reads AWS_REGION, as ECS sets it in a task; AWS_DEFAULT_REGION is what the Chat Service's own fallbacks read.
        AWS_REGION: 'us-east-1',
        AWS_DEFAULT_REGION: 'us-east-1',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_ENDPOINT_URL_DYNAMODB: dynamodbEndpoint,
        BOTCUBE_CHAT_TABLE: table,
        BOTCUBE_LOCAL_HARNESS_URL: harnessUrl,
        ...(authorizer ? {
          BOTCUBE_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
          BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([{ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'local' }]),
        } : {}),
        BOTCUBE_LOCAL_SESSION_API_URL: sessionApi,
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url,
        ...(scheduledRuns ? {
          AWS_ENDPOINT_URL_SCHEDULER: dynamodbEndpoint,
          AWS_ENDPOINT_URL_SQS: dynamodbEndpoint,
          BOTCUBE_SCHEDULE_GROUP: scheduledRuns.group,
          BOTCUBE_SCHEDULER_ROLE_ARN: scheduledRuns.roleArn,
          BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN: scheduledRuns.queueArn,
          BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: scheduledRuns.queueUrl,
        } : {}),
        ...egress?.chatEnvironment,
        ...modelsEnv?.chatService,
        ...credentialService,
        ...turnCredentialsEnv(deployment.config, dynamodbEndpoint),
        ...options.chatEnv,
        BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig,
      },
      '/',
      'Chat Service listening on :',
    );
    const chatService = required(processes.at(-1), 'Chat Service process');
    authorizer?.trust(`${url}/.well-known/openid-configuration`);
    const restartHarness = async () => {
      await required(harnessProcess, 'Harness process').stop();
      harnessProcess = await startProcess(required(harnessOptions, 'Harness start options'));
      processes.push(harnessProcess);
    };
    return { url, bedrock, ...(openAICompatible ? { openAICompatible } : {}), harnessUrl, egress, restartHarness, ...(scheduledRuns ? { scheduler: new SchedulerView(dynamodbEndpoint, scheduledRuns) } : {}), browser: () => new Browser(url), logs: () => chatService.output(), stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

interface EgressStandIns {
  readonly proxy: FakeForwardProxy;
  readonly collector: FakeOtlpCollector | undefined;
  /** The sections the Deployment Config stand-in takes in place of the deployed proxy and telemetry. */
  readonly offline: Pick<DeploymentConfig, 'proxy' | 'telemetry'>;
  readonly environment: Record<string, string>;
  readonly chatEnvironment: Record<string, string>;
}

/**
 * The Deployment Config's proxy offline, carrying its collector's host to a stand-in collector that takes only the
 * telemetry Endpoint's stand-in token, held in a file as a secret injector mounts it; and the standard variables the deploy
 * sets beside the Deployment Config. A proxy with a credential takes only its stand-in token, from a file, which the Chat Service and the Harness
 * each send through their own relay, on a port of their own here as each has its own loopback when deployed.
 */
async function egressStandIns(config: DeploymentConfig | undefined, home: string): Promise<EgressStandIns | undefined> {
  const proxy = config?.proxy;
  if (proxy === undefined || proxy.kind === 'none') return undefined;
  const otlp = config?.telemetry.kind === 'otlp' ? config.telemetry : undefined;
  const collector = otlp && await new FakeOtlpCollector(otlp.credential ? `Bearer ${STAND_IN_TELEMETRY_TOKEN}` : undefined).listen();
  const standIn = await new FakeForwardProxy(
    otlp && collector ? { [new URL(otlp.url).host]: collector.url } : {},
    proxy.credential ? `Bearer ${STAND_IN_PROXY_TOKEN}` : undefined,
  ).listen();
  const offlineTelemetry = otlp && {
    ...otlp,
    ...(otlp.credential ? { credential: { kind: 'file', path: await keyFile(home, STAND_IN_TELEMETRY_TOKEN, 'telemetry-token') } as const } : {}),
  };
  const telemetry = offlineTelemetry && telemetryDeployment(offlineTelemetry);
  const offline = {
    telemetry: offlineTelemetry ?? required(config, 'Deployment Config').telemetry,
    proxy: {
      ...proxy,
      url: standIn.url,
      ...(proxy.credential ? { credential: { kind: 'file', path: await keyFile(home, STAND_IN_PROXY_TOKEN, 'proxy-token') } as const } : {}),
    },
  };
  return {
    proxy: standIn,
    collector,
    offline,
    environment: standardVariables({ ...proxyEnvironment(offline, { relayPort: await freePort() }), ...telemetry?.harness }),
    chatEnvironment: standardVariables({ ...proxyEnvironment(offline, { relayPort: await freePort() }), ...telemetry?.chatService }),
  };
}

/** The deploy's environment without the BOTCUBE_* values it projects from the Deployment Config, which every process reads from the file. */
function standardVariables(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('BOTCUBE_')));
}

const STAND_IN_TELEMETRY_TOKEN = 'stand-in-telemetry-token';
const MODELS_INVOCATION_SECRET = 'local-models-invocation-secret';
const STAND_IN_PROXY_TOKEN = 'stand-in-proxy-token';

/** A file in `home` holding `value`, by its path. */
async function keyFile(home: string, value: string, name = 'models-api-key'): Promise<string> {
  const path = join(home, name);
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return path;
}

/** The OIDC client secret the stand-in provider takes, in place of the one the Deployment Config's source names. */
const STAND_IN_CLIENT_SECRET = 'stand-in-client-secret';

/**
 * The Deployment Config every process reads: the one at `path`, with its proxy and telemetry offline and its sign-in
 * client secret a file in `home` as a secret injector mounts it, so no Secrets Manager is needed offline; unchanged
 * when none of those apply.
 */
async function standInDeploymentConfig(
  path: string,
  config: DeploymentConfig,
  home: string,
  offline: Pick<DeploymentConfig, 'proxy' | 'telemetry'> | undefined,
): Promise<string> {
  if (config.identity.kind !== 'oidc' && offline === undefined) return path;
  const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const clientSecret = { kind: 'file', path: await keyFile(home, STAND_IN_CLIENT_SECRET, 'oidc-client-secret') } as const;
  const identity = config.identity.kind === 'oidc'
    ? { identity: { ...config.identity, clients: config.identity.clients.map(({ clientId }) => ({ clientId, clientSecret })) } }
    : {};
  const standIn = join(home, 'deployment-config.json');
  await writeFile(standIn, JSON.stringify({ ...file, bot: resolve(dirname(path), config.bot), ...identity, ...offline }));
  return standIn;
}

/** What the CDK hands the Chat Service for the Deployment Config's Turn credentials adapter, with moto as STS. */
function turnCredentialsEnv(config: DeploymentConfig, sts: string): NodeJS.ProcessEnv {
  if (config.turnCredentials.kind !== 'assume-role') return {};
  return { AWS_ENDPOINT_URL_STS: sts, BOTCUBE_USER_MEMORY_ROLE_ARN: 'arn:aws:iam::123456789012:role/bot-cube-user-memory' };
}
