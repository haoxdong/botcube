import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { required } from '../required.js';
import { Browser } from './browser.js';
import { loadConfig } from '../../../config/load.js';
import { readConfig } from '../../../config/read.cjs';
import { proxyEnvironment } from '../../../config/environment.js';
import { telemetryEnvironment } from '../../../config/telemetry.js';
import { FakeBedrock, FakeOpenAICompatible } from '../fakes/fake-backends.js';
import { FakeForwardProxy, FakeOtlpCollector } from '../fakes/egress.js';
import { FakeMtlsFront, FakeMtlsProxy, mtlsCertificates, SERVER_IDENTITY, type MtlsCertificates } from '../fakes/mtls.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../fakes/stack.js';
import { freePort, startOnFreePort, startProcess, type RunningProcess } from '../fakes/process.js';
import { createScheduledRuns, SchedulerView } from '../fakes/scheduler.js';
import { motoEndpoint } from '../fakes/moto.js';
import { FakeJwtAuthorizer } from '../fakes/jwt-authorizer.js';
import type { BotCubeConfig } from '../../../config/schema.js';

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
  `${HARNESS_BIN}/python -c "from botcube_harness_deepagents import llm, serving, bot_settings; from pathlib import Path; import os; ` +
  `read_settings = bot_settings.load_bot_settings; bot_settings.load_bot_settings = lambda path: read_settings(Path(os.environ['BOTCUBE_TEST_IMAGE_SETTINGS'])); ` +
  `llm.AVAILABLE_MODELS.update(dict.fromkeys(llm.AVAILABLE_MODELS, 'echo')); serving.main()"`;

/** The stock Chat Service, as its image runs it. */
const CHAT_SERVICE_COMMAND = `node --import ${fileURLToPath(new URL('../image-process.mjs', import.meta.url))} ${fileURLToPath(new URL('../../dist/main.js', import.meta.url))}`;

/** The BotCube Config the stack deploys unless given one: the public example's. */
const PUBLIC_EXAMPLE = fileURLToPath(new URL('../../../examples/public/botcube.yaml', import.meta.url));

export interface LocalStack {
  readonly url: string;
  /** The Bedrock Converse endpoint each finished Turn is summarized at. */
  readonly bedrock: FakeBedrock;
  /** The stand-in for a BotCube Config's OpenAI-compatible models endpoint, when it names one. */
  readonly openAICompatible?: FakeOpenAICompatible;
  readonly scheduler?: SchedulerView;
  /** The Harness as the Chat Service reaches it: behind the Runtime's JWT authorizer when the Harness auth is a bearer. */
  readonly harnessUrl: string;
  /** The stand-ins for a BotCube Config's proxy and traces collector, when it names a proxy. */
  readonly egress: EgressStandIns | undefined;
  /** With `endpointTls`, the mTLS proxy the BotCube Config's proxy is replaced by, and the mTLS front of the models Endpoint behind it. */
  readonly mtls?: { readonly proxy: FakeMtlsProxy; readonly front: FakeMtlsFront };
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
  /** The BotCube Config the stack deploys, its External Services replaced by their offline stand-ins; the public example's unless given. */
  botcubeConfig?: string;
  /**
   * Gives the BotCube Config's proxy and models Endpoint a `tls` block: the proxy becomes an mTLS stand-in at an
   * https URL, and the models Endpoint, at `MTLS_MODELS_HOST`, is reached through it behind an mTLS front.
   */
  endpointTls?: boolean;
} = {}): Promise<LocalStack> {
  const dynamodbEndpoint = motoEndpoint();
  // Startup stops on a bad BotCube Config before any process starts, naming the field, as the Chat Service's does.
  // Only the processes run on the Bot Image's /bot/bot.yaml (image-process.mjs), so this one reads the BotCube Config alone.
  const deploymentPath = options.botcubeConfig ?? options.chatEnv?.BOTCUBE_CONFIG ?? PUBLIC_EXAMPLE;
  const config = loadConfig(deploymentPath);
  const home = await mkdtemp('/tmp/bc-');
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(dynamodbEndpoint, table);
  // The table poller needs its run queue to start, as the CDK always gives it one (`scheduled-runs.ts` in botcube/infra/ecs/cdk).
  const scheduledRuns = options.scheduling || config.schedules.kind === 'table-poller' ? await createScheduledRuns(dynamodbEndpoint) : undefined;
  const pythonEnv = {
    PATH: process.env.PATH,
    BOTCUBE_TEST_IMAGE_SETTINGS: fileURLToPath(new URL('../../../examples/bot/bot.yaml', import.meta.url)),
    HOME: home,
    AGENTCORE_MEMORY_ID: '',
    LANGSMITH_TRACING: 'false',
    BOTCUBE_CHECKPOINT_PATH: join(home, 'checkpoints.sqlite3'),
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
  const models = config.integrations.modelGateway;
  const openAICompatible = models.kind === 'openai-compatible' ? await new FakeOpenAICompatible(`sk-${table}`).listen() : undefined;
  const harnessAuth = config.integrations.harnessAuth;
  const mtls = options.endpointTls ? await mtlsStandIns(required(openAICompatible, 'the models Endpoint stand-in an mTLS front carries to'), home) : undefined;
  const egress = await egressStandIns(config, home, mtls);
  let authorizer: FakeJwtAuthorizer | undefined;
  const stopAll = async () => {
    await Promise.all([
      ...processes.map((running) => running.stop()), bedrock.close(), openAICompatible?.close(), authorizer?.close(), egress?.proxy.close(), egress?.collector?.close(),
      mtls?.proxy.close(), mtls?.front.close(),
    ]);
    mtls?.certificates.remove();
    await rm(home, { recursive: true, force: true });
  };
  try {
    // Every process reads the one BotCube Config, its External Services replaced by their offline stand-ins.
    // The models Endpoint's stand-in, its API key in a file as a secret injector mounts it, for the Chat Service's Turn
    // Summary and the Credential Service the Harness relays through; the Endpoint's headers are the BotCube Config's own.
    const modelsStandIn = await standInModels(models, openAICompatible, home, mtls);
    const botcubeConfig = await standInBotCubeConfig(deploymentPath, config, home, { ...egress?.offline, ...modelsStandIn });
    // The Harness serves the bot settings the BotCube Config's `bot` names, as the example bot's image does.
    Object.assign(pythonEnv, egress?.environment, mtls?.pythonTrust, { BOTCUBE_CONFIG: botcubeConfig }, options.harnessEnv);
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
    const credentialService = modelsStandIn && {
      BOTCUBE_CREDENTIAL_SERVICE_URL: await start(
        `${CREDENTIAL_SERVICE_BIN}/python ${fileURLToPath(new URL('models-credential-service.py', import.meta.url))}`,
        {
          PATH: process.env.PATH,
          HOME: home,
          BOTCUBE_CREDENTIAL_INVOCATION_SECRET: MODELS_INVOCATION_SECRET,
          ...egress?.credentialEnvironment,
          BOTCUBE_CONFIG: botcubeConfig, BOTCUBE_TEST_IMAGE_SETTINGS: fileURLToPath(new URL('../../../examples/bot/bot.yaml', import.meta.url)),
          ...mtls?.pythonTrust,
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
        ...mtls?.chatTrust,
        ...credentialService,
        ...awsAccessEnv(config, dynamodbEndpoint),
        ...options.chatEnv,
        BOTCUBE_CONFIG: botcubeConfig, BOTCUBE_TEST_IMAGE_SETTINGS: fileURLToPath(new URL('../../../examples/bot/bot.yaml', import.meta.url)),
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
    return { url, bedrock, ...(openAICompatible ? { openAICompatible } : {}), harnessUrl, egress, ...(mtls ? { mtls } : {}), restartHarness, ...(scheduledRuns ? { scheduler: new SchedulerView(dynamodbEndpoint, scheduledRuns) } : {}), browser: () => new Browser(url), logs: () => chatService.output(), stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

interface EgressStandIns {
  readonly proxy: FakeForwardProxy;
  readonly collector: FakeOtlpCollector | undefined;
  /** The sections the BotCube Config stand-in takes in place of the deployed proxy and telemetry. */
  readonly offline: { proxy: BotCubeConfig['integrations']['proxy']; telemetry: BotCubeConfig['integrations']['telemetry'] };
  readonly environment: Record<string, string>;
  readonly chatEnvironment: Record<string, string>;
  readonly credentialEnvironment: Record<string, string>;
}

/** The models Endpoint's host behind the mTLS stand-ins, reached only through the proxy, which routes it to the front. */
export const MTLS_MODELS_HOST = 'models.example.test';

interface MtlsStandIns {
  readonly certificates: MtlsCertificates;
  readonly proxy: FakeMtlsProxy;
  readonly proxyUrl: URL;
  readonly front: FakeMtlsFront;
  /** The stand-in CA as each process's trust roots, as SSL_CERT_FILE and NODE_EXTRA_CA_CERTS set them when deployed. */
  readonly pythonTrust: Record<string, string>;
  readonly chatTrust: Record<string, string>;
}

/** An mTLS proxy routing `MTLS_MODELS_HOST` to an mTLS front over `models`, both carrying the stand-in server identity. */
async function mtlsStandIns(models: FakeOpenAICompatible, home: string): Promise<MtlsStandIns> {
  const certificates = mtlsCertificates();
  const front = new FakeMtlsFront(certificates, Number(new URL(models.url).port));
  const proxy = new FakeMtlsProxy(certificates, 'server', { [`${MTLS_MODELS_HOST}:443`]: await front.listen() });
  const ca = join(home, 'stand-in-ca.pem');
  await writeFile(ca, certificates.authority);
  return { certificates, proxy, proxyUrl: await proxy.listen(), front, pythonTrust: { SSL_CERT_FILE: ca }, chatTrust: { NODE_EXTRA_CA_CERTS: ca } };
}

/**
 * The BotCube Config's proxy offline, carrying its collector's host to a stand-in collector that takes only the
 * telemetry Endpoint's stand-in token, held in a file as a secret injector mounts it; and the standard variables the deploy
 * sets beside the BotCube Config. A proxy with a credential takes only its stand-in token, from a file, which the Chat Service, the Harness and the Credential Service
 * each send through their own relay, on a port of their own here as each has its own loopback when deployed.
 */
async function egressStandIns(config: BotCubeConfig | undefined, home: string, mtls?: MtlsStandIns): Promise<EgressStandIns | undefined> {
  const proxy = config?.integrations.proxy;
  if (proxy === undefined || proxy.kind === 'none') return undefined;
  const otlp = config?.integrations.telemetry.kind === 'otlp' ? config.integrations.telemetry : undefined;
  const collector = otlp && await new FakeOtlpCollector(otlp.credential ? `Bearer ${STAND_IN_TELEMETRY_TOKEN}` : undefined).listen();
  const standIn = await new FakeForwardProxy(
    otlp && collector ? { [new URL(otlp.url).host]: collector.url } : {},
    proxy.credential ? `Bearer ${STAND_IN_PROXY_TOKEN}` : undefined,
  ).listen();
  const offlineTelemetry = otlp && {
    ...otlp,
    ...(otlp.credential ? { credential: { kind: 'file', path: await keyFile(home, STAND_IN_TELEMETRY_TOKEN, 'telemetry-token') } as const } : {}),
  };
  const telemetry = offlineTelemetry && telemetryEnvironment(offlineTelemetry);
  const offline = {
    telemetry: offlineTelemetry ?? required(config, 'BotCube Config').integrations.telemetry,
    proxy: {
      ...proxy,
      url: mtls ? mtls.proxyUrl.href : standIn.url,
      ...(proxy.credential ? { credential: { kind: 'file', path: await keyFile(home, STAND_IN_PROXY_TOKEN, 'proxy-token') } as const } : {}),
      ...(mtls ? { tls: { clientCertificate: mtls.certificates.files.clientB, serverIdentity: SERVER_IDENTITY } } : {}),
    },
  };
  return {
    proxy: standIn,
    collector,
    offline,
    environment: { ...proxyEnvironment({ integrations: { proxy: offline.proxy } }, { relayPort: await freePort() }), ...telemetry?.harness },
    chatEnvironment: { ...proxyEnvironment({ integrations: { proxy: offline.proxy } }, { relayPort: await freePort() }), ...telemetry?.chatService },
    credentialEnvironment: proxyEnvironment({ integrations: { proxy: offline.proxy } }, { relayPort: await freePort() }),
  };
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

/** The OIDC client secret the stand-in provider takes, in place of the one the BotCube Config's source names. */
const STAND_IN_CLIENT_SECRET = 'stand-in-client-secret';

async function standInBotCubeConfig(
  path: string,
  config: BotCubeConfig,
  home: string,
  offline: { proxy?: BotCubeConfig['integrations']['proxy']; telemetry?: BotCubeConfig['integrations']['telemetry']; models?: BotCubeConfig['integrations']['modelGateway'] },
): Promise<string> {
  const localDomains = path === PUBLIC_EXAMPLE
    ? loadConfig(fileURLToPath(new URL('../../../infra/local/deployment/botcube.yaml', import.meta.url))).domains
    : undefined;
  if (!localDomains && config.integrations.signIn.kind !== 'oidc' && Object.keys(offline).length === 0) return path;
  const file = readConfig(path);
  const clientSecret = { kind: 'file', path: await keyFile(home, STAND_IN_CLIENT_SECRET, 'oidc-client-secret') } as const;
  const identity = config.integrations.signIn.kind === 'oidc'
    ? { signIn: { ...config.integrations.signIn, clients: config.integrations.signIn.clients.map(({ clientId }) => ({ clientId, clientSecret })) } }
    : {};
  const standIn = join(home, 'botcube.yaml');
  await writeFile(standIn, JSON.stringify({ ...file, ...(localDomains ? { domains: localDomains } : {}), integrations: { ...config.integrations, ...identity, ...(offline.telemetry ? { telemetry: offline.telemetry } : {}), ...(offline.models ? { modelGateway: offline.models } : {}), ...(offline.proxy ? { proxy: offline.proxy } : {}) } }));
  return standIn;
}

/** What the CDK hands the Chat Service for the BotCube Config's Turn credentials adapter, with moto as STS. */
function awsAccessEnv(config: BotCubeConfig, sts: string): NodeJS.ProcessEnv {
  if (config.integrations.awsAccess.kind !== 'assume-role') return {};
  return { AWS_ENDPOINT_URL_STS: sts, BOTCUBE_USER_MEMORY_ROLE_ARN: 'arn:aws:iam::123456789012:role/bot-cube-user-memory' };
}

/** The BotCube Config's models Endpoint at its stand-in, behind the mTLS stand-ins when given. */
async function standInModels(models: BotCubeConfig['integrations']['modelGateway'], openAICompatible: FakeOpenAICompatible | undefined, home: string, mtls: MtlsStandIns | undefined) {
  if (openAICompatible === undefined || models.kind !== 'openai-compatible') return undefined;
  return {
    models: {
      ...models,
      url: mtls ? `https://${MTLS_MODELS_HOST}/v1` : `${openAICompatible.url}/v1`,
      credential: { kind: 'file', path: await keyFile(home, openAICompatible.apiKey) },
      ...(mtls ? { tls: { clientCertificate: mtls.certificates.files.clientA, serverIdentity: SERVER_IDENTITY } } : {}),
    } satisfies BotCubeConfig['integrations']['modelGateway'],
  };
}
