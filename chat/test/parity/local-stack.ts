import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { required } from '../required.js';
import { Browser } from './browser.js';
import { FakeBedrock } from '../fakes/fake-backends.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../fakes/stack.js';
import { startOnFreePort, startProcess, type RunningProcess } from '../fakes/process.js';
import { createScheduledRuns, SchedulerView } from '../fakes/scheduler.js';
import { motoEndpoint } from '../fakes/moto.js';

/**
 * The template Cartridge's environment: it holds the Harness and the template Harness half.
 * The services start from their console scripts' entry points, as the Harness image does, so
 * each module runs under its own name rather than as `__main__`.
 */
const BIN = fileURLToPath(new URL('../../../templates/always-on/.venv/bin', import.meta.url));

const HARNESS_COMMAND =
  `${BIN}/python -c "from botcube_harness_deepagents import llm, serving; ` +
  `llm.AVAILABLE_MODELS.update(dict.fromkeys(llm.AVAILABLE_MODELS, 'echo')); serving.main()"`;

const CHAT_SERVICE_COMMAND =
  `node ${fileURLToPath(new URL('../../../templates/always-on/chat/dist/main.js', import.meta.url))}`;

export interface LocalStack {
  readonly url: string;
  /** The Bedrock Converse endpoint each finished Turn is summarized at. */
  readonly bedrock: FakeBedrock;
  readonly scheduler?: SchedulerView;
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
export async function startLocalStack(options: { harnessCommand?: string; chatServiceCommand?: string; harnessEnv?: NodeJS.ProcessEnv; chatEnv?: NodeJS.ProcessEnv; scheduling?: boolean } = {}): Promise<LocalStack> {
  const dynamodbEndpoint = motoEndpoint();
  const home = await mkdtemp('/tmp/bc-');
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(dynamodbEndpoint, table);
  const scheduledRuns = options.scheduling ? await createScheduledRuns(dynamodbEndpoint) : undefined;
  const pythonEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AGENTCORE_MEMORY_ID: '',
    LANGSMITH_TRACING: 'false',
    BOTCUBE_MODEL: 'echo',
    BOTCUBE_CHECKPOINT_PATH: join(home, 'checkpoints.sqlite3'),
    BOTCUBE_CARTRIDGE_MODULE: 'botcube_always_on.harness',
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
  const stopAll = async () => {
    await Promise.all([...processes.map((running) => running.stop()), bedrock.close()]);
    await rm(home, { recursive: true, force: true });
  };
  try {
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
    const url = await start(
      options.chatServiceCommand ?? CHAT_SERVICE_COMMAND,
      {
        PATH: process.env.PATH,
        HOME: home,
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        AWS_DEFAULT_REGION: 'us-east-1',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_ENDPOINT_URL_DYNAMODB: dynamodbEndpoint,
        BOTCUBE_CHAT_TABLE: table,
        BOTCUBE_LOCAL_HARNESS_URL: harness,
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
        ...options.chatEnv,
      },
      '/',
      'Chat Service listening on :',
    );
    const chatService = required(processes.at(-1), 'Chat Service process');
    const restartHarness = async () => {
      await required(harnessProcess, 'Harness process').stop();
      harnessProcess = await startProcess(required(harnessOptions, 'Harness start options'));
      processes.push(harnessProcess);
    };
    return { url, bedrock, restartHarness, ...(scheduledRuns ? { scheduler: new SchedulerView(dynamodbEndpoint, scheduledRuns) } : {}), browser: () => new Browser(url), logs: () => chatService.output(), stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}
