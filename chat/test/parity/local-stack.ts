import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { required } from '../required.js';
import { Browser } from './browser.js';
import { CreateSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { loadDeployment } from '../../../deployment-config/load.js';
import { modelsDeployment } from '../../../deployment-config/models.js';
import { FakeBedrock, FakeOpenAICompatible } from '../fakes/fake-backends.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../fakes/stack.js';
import { startOnFreePort, startProcess, type RunningProcess } from '../fakes/process.js';
import { createScheduledRuns, SchedulerView } from '../fakes/scheduler.js';
import { motoEndpoint } from '../fakes/moto.js';
import { FakeJwtAuthorizer } from '../fakes/jwt-authorizer.js';
import type { DeploymentConfig } from '../../../deployment-config/schema.js';

/** The Chat Service's public origin, the issuer of its tokens; the Harness's authorizer reaches it at its local address. */
export const PUBLIC_ORIGIN = 'https://chat.example.test';

/**
 * The template Python environment: it holds the Harness (and, for now, the template Harness half).
 * The services start from their console scripts' entry points, as the Harness image does, so
 * each module runs under its own name rather than as `__main__`.
 */
const BIN = fileURLToPath(new URL('../../../templates/always-on/.venv/bin', import.meta.url));

const HARNESS_COMMAND =
  `${BIN}/python -c "from botcube_harness_deepagents import llm, serving; ` +
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
  let authorizer: FakeJwtAuthorizer | undefined;
  const stopAll = async () => {
    await Promise.all([...processes.map((running) => running.stop()), bedrock.close(), openAICompatible?.close(), authorizer?.close()]);
    await rm(home, { recursive: true, force: true });
  };
  try {
    // The models endpoint's stand-in, its API key in moto's Secrets Manager, for both the Chat Service and the Harness.
    const modelsEnv = {
      ...modelsDeployment(models)?.environment,
      ...(openAICompatible ? {
        BOTCUBE_MODELS_BASE_URL: `${openAICompatible.url}/v1`,
        BOTCUBE_MODELS_API_KEY_SECRET_ARN: await createSecret(dynamodbEndpoint, `models-api-key-${table}`, openAICompatible.apiKey),
        AWS_ENDPOINT_URL_SECRETS_MANAGER: dynamodbEndpoint,
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        AWS_EC2_METADATA_DISABLED: 'true',
      } : {}),
    };
    Object.assign(pythonEnv, modelsEnv, options.harnessEnv);
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
    let harnessProcess: RunningProcess | undefined;
    let harnessOptions: Parameters<typeof startProcess>[0] | undefined;
    const [harness, sessionApi] = await Promise.all([
      startOnFreePort((port) => {
        harnessOptions = { command: options.harnessCommand ?? HARNESS_COMMAND, env: { ...pythonEnv, PORT: String(port) }, url: `http://127.0.0.1:${port}/ping`, listening: `Uvicorn running on http://0.0.0.0:${port}` };
        return harnessOptions;
      }).then((running) => { harnessProcess = running; processes.push(running); return new URL(running.url).origin; }),
      start(`${BIN}/botcube-session-api`, pythonEnv, '/ping', 'Uvicorn running on http://0.0.0.0:'),
    ]);
    if (harnessAuth.kind === 'jwt-bearer') authorizer = await new FakeJwtAuthorizer(harness, harnessAuth.audience).listen();
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
        BOTCUBE_DEPLOYMENT_CONFIG: deploymentPath,
        ...modelsEnv,
        ...turnCredentialsEnv(deployment.config, dynamodbEndpoint),
        ...options.chatEnv,
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
    return { url, bedrock, ...(openAICompatible ? { openAICompatible } : {}), harnessUrl, restartHarness, ...(scheduledRuns ? { scheduler: new SchedulerView(dynamodbEndpoint, scheduledRuns) } : {}), browser: () => new Browser(url), logs: () => chatService.output(), stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

/** A secret in moto's Secrets Manager holding `value`, by its ARN. */
async function createSecret(endpoint: string, name: string, value: string): Promise<string> {
  const client = new SecretsManagerClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
  try {
    const { ARN } = await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    return required(ARN, "the created secret's ARN");
  } finally {
    client.destroy();
  }
}

/** What the CDK hands the Chat Service for the Deployment Config's Turn credentials adapter, with moto as STS. */
function turnCredentialsEnv(config: DeploymentConfig, sts: string): NodeJS.ProcessEnv {
  if (config.turnCredentials.kind !== 'assume-role') return {};
  return { AWS_ENDPOINT_URL_STS: sts, BOTCUBE_USER_MEMORY_ROLE_ARN: 'arn:aws:iam::123456789012:role/bot-cube-user-memory' };
}
