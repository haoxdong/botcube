import { loadResolvedConfig } from 'botcube-config/resolved';
import { TurnQuota, type TurnQuotaLimits } from '../src/turn-quota.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Hono } from 'hono';
import { DynamoDBAgentDocuments } from '../src/agent-documents.js';
import type { AccountHistory } from '../src/account-history.js';
import { configAdapters } from '../src/config-adapters.js';
import { createChatService, type ChatServiceConfig } from '../src/server.js';
import type { SessionApi } from '../src/session-api.js';
import { DynamoDBSessionMetadata } from '../src/session-metadata.js';
import { ScheduledTasks } from '../src/scheduled-tasks.js';
import { sqsRunQueue, type RunQueue } from '../src/scheduled-runs.js';
import type { ParkHistory } from '../src/park-history.js';
import type { ProductionActivity } from '../src/production-activity.js';
import { SchedulerView, createScheduledRuns } from './fakes/scheduler.js';
import { FakeAgentCore } from './fakes/fake-agentcore.js';
import { FakeSessionApi } from './fakes/fake-backends.js';
import { RUNTIME_ARN, createChatTable } from './fakes/stack.js';
import { motoAws, motoEndpoint } from './fakes/moto.js';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { StockOptions } from '../src/stock.js';
import { TEST_ACCOUNT_KEY, TestAccounts, testBotCubeConfig } from './stock-bot.js';

/** The account every request signs in as, unless the x-test-owner header names another. */
const OWNER = 'acct_account-1';

export interface InProcessOptions {
  turnQuota?: TurnQuotaLimits;
  env?: NodeJS.ProcessEnv;
  /** Another Chat Service instance uses this already-created table. */
  existingTable?: string;
  invokeSessionApi?: SessionApi;
  /** Hooks replaced on BotCube's own Chat, which serves the test bot's BotCube Config as production does. */
  overrides?: StockOptions['overrides'];
  /** Sections of the BotCube Config the Chat Service serves, such as its `domains`. */
  botcube?: Record<string, unknown>;
  /** Overrides of the Chat Service config, which points AgentCore and the session API at the fakes. */
  config?: Partial<ChatServiceConfig>;
  /** Session Metadata table: created (default) or missing. */
  table?: 'created' | 'missing';
  /** Scheduled tasks: unconfigured (default), or a schedule group and run queue of the stack's own in moto. */
  scheduled?: boolean;
  /** Production's park state over time, which this stack's scheduled runs check. */
  parkHistory?: ParkHistory;
  activity?: ProductionActivity;
  /** The drain check used by this stack's scheduled-runs poller. */
  scheduledDraining?: () => Promise<boolean>;
}

export interface InProcessStack {
  /** The Chat Service app: drive it with `app.request()`. */
  readonly app: Hono;
  readonly accounts: TestAccounts;
  readonly agentcore: FakeAgentCore;
  readonly sessionApi: FakeSessionApi;
  /** The Bedrock Converse endpoint each finished Turn is summarized at. */
  /** A real DynamoDB Session Metadata over this stack's own table in the run's moto. */
  readonly sessionMetadata: DynamoDBSessionMetadata;
  /** This stack's own DynamoDB table and a client of it, for rows earlier versions wrote. */
  readonly table: { name: string; client: DynamoDBClient };
  /** The account-history hooks the Chat Service handed the Chat. */
  readonly history: AccountHistory;
  /** The stack's schedules and run queue, when it has scheduled tasks. */
  readonly scheduler: SchedulerView | null;
  /** Allocates a Session under a test-chosen ID through the path `POST /threads` takes, as the server issues every Session ID. */
  allocate(owner: string, sessionId: string): Promise<string>;
  stop(): Promise<void>;
}

/** The parity suite's fakes and a fresh Session Metadata table, wired to an in-process Chat Service. */
export async function startInProcess(options: InProcessOptions = {}): Promise<InProcessStack> {
  const endpoint = motoEndpoint();
  const table = options.existingTable ?? `chat-${Math.random().toString(36).slice(2)}`;
  if (options.existingTable === undefined && (options.table ?? 'created') === 'created') {
    await createChatTable(endpoint, table);
  }
  const client = new DynamoDBClient(motoAws());
  const sessionMetadata = new DynamoDBSessionMetadata(table, client);
  const agentcore = await new FakeAgentCore().listen();
  const sessionApi = await new FakeSessionApi().listen();
  const botcubeConfig = testBotCubeConfig(undefined, options.botcube);
  const env = { BOTCUBE_CONFIG: botcubeConfig, BOTCUBE_CHAT_TABLE: table, ...options.env };
  const resolved = loadResolvedConfig(env.BOTCUBE_CONFIG);
  const config: ChatServiceConfig = {
    agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agentcore.url },
    localHarnessUrl: null,
    corsOrigins: configAdapters(env, resolved).corsOrigins,
    region: 'us-east-1',
    agentCoreEndpoint: agentcore.url,
    browserId: 'aws.browser.v1',
    sessionApi: { localUrl: sessionApi.url },
    warmupTimeoutMs: 10_000,
    ...options.config,
  };
  const aws = motoAws();
  const runs = options.scheduled === true ? await createScheduledRuns(endpoint) : null;
  let stopped = false;
  const queue = runs && sqsRunQueue(runs.queueUrl, new SQSClient(aws));
  // A stopped stack's poller waits forever rather than polling a queue no test reads.
  const runQueue: RunQueue | null = queue && {
    receive: (signal) => (stopped ? new Promise(() => undefined) : queue.receive(signal)),
    delete: (receipt) => queue.delete(receipt),
  };
  const accounts = new TestAccounts(table, DynamoDBDocumentClient.from(client));
  const { app: service, chat, history } = createChatService(
    {
      env,
      resolved,
      accountStore: accounts,
      // The Agent Computer is an External Service: these tests start no browser.
      agentComputer: (local) => ({ ...local, warmSession: async () => undefined, turnStarting: () => undefined }),
      overrides: options.overrides ?? {},
    },
    config,
    options.activity?.observe(sessionMetadata) ?? sessionMetadata,
    new DynamoDBAgentDocuments(table, client),
    options.invokeSessionApi,
    runs && runQueue && { tasks: new ScheduledTasks(table, runs, client, new SchedulerClient(aws)), queue: runQueue, draining: options.scheduledDraining ?? (async () => false), parkHistory: options.parkHistory },
    options.turnQuota ? new TurnQuota(table, client, options.turnQuota) : null,
  );
  // Each request arrives signed in as its test owner, through the test bot's session cookie; with no account
  // storage to sign in on, it arrives as a browser with no session would.
  const app = new Hono().all('*', async (c) => {
    const headers = new Headers(c.req.raw.headers);
    const token = await accounts.signIn(c.req.header('x-test-owner') ?? OWNER).catch(() => null);
    if (token !== null) headers.append('cookie', `${TEST_ACCOUNT_KEY}_session=${token}`);
    return service.fetch(new Request(c.req.raw, { headers }), c.env);
  });
  return {
    app,
    accounts,
    history,
    agentcore,
    sessionApi,
    sessionMetadata,
    table: { name: table, client },
    scheduler: runs && new SchedulerView(endpoint, runs),
    async allocate(owner, sessionId) {
      await sessionMetadata.recordTurn(owner, sessionId, { filingUserId: chat.filingUserId(owner), title: '', warmup: true, allocation: true });
      return sessionId;
    },
    async stop() {
      stopped = true;
      await Promise.all([agentcore.close(), sessionApi.close()]);
    },
  };
}
