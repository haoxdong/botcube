import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Hono } from 'hono';
import { inject } from 'vitest';
import { DynamoDBAgentDocuments } from '../src/agent-documents.js';
import type { AccountHistory, ChatServiceCartridge } from '../src/cartridge.js';
import { createChatService, type ChatServiceConfig } from '../src/server.js';
import { DynamoDBSessionMetadata } from '../src/session-metadata.js';
import { ScheduledTasks } from '../src/scheduled-tasks.js';
import { sqsRunQueue, type RunQueue } from '../src/scheduled-runs.js';
import { SchedulerView, createScheduledRuns } from './fakes/scheduler.js';
import { FakeAgentCore } from './fakes/fake-agentcore.js';
import { FakeBedrock, FakeSessionApi } from './fakes/fake-backends.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, RUNTIME_ARN, createChatTable } from './fakes/stack.js';
// Types the run's moto endpoint, which the shared global setup provides as `dynamodbEndpoint`.
import type {} from './fakes/global-setup.js';

/** The account every request acts as, unless a test's Cartridge resolves another. */
const OWNER = 'account-1';

export interface InProcessOptions {
  /** Overrides of the test Cartridge, which acts for OWNER (or the x-test-owner header's account) and forwards each Turn as sent. */
  cartridge?: Partial<ChatServiceCartridge>;
  /** Overrides of the Chat Service config, which points AgentCore and the session API at the fakes. */
  config?: Partial<ChatServiceConfig>;
  /** Session Metadata table: created (default) or missing. */
  table?: 'created' | 'missing';
  /** Scheduled tasks: unconfigured (default), or a schedule group and run queue of the stack's own in moto. */
  scheduled?: boolean;
  /** The drain check used by this stack's scheduled-runs poller. */
  scheduledDraining?: () => Promise<boolean>;
}

export interface InProcessStack {
  /** The Chat Service app: drive it with `app.request()`. */
  readonly app: Hono;
  readonly agentcore: FakeAgentCore;
  readonly sessionApi: FakeSessionApi;
  /** The Bedrock Converse endpoint each finished Turn is summarized at. */
  readonly bedrock: FakeBedrock;
  /** A real DynamoDB Session Metadata over this stack's own table in the run's moto. */
  readonly sessionMetadata: DynamoDBSessionMetadata;
  /** This stack's own DynamoDB table and a client of it, for rows earlier versions wrote. */
  readonly table: { name: string; client: DynamoDBClient };
  /** The account-history hooks the Chat Service handed the Cartridge. */
  readonly history: AccountHistory;
  /** The stack's schedules and run queue, when it has scheduled tasks. */
  readonly scheduler: SchedulerView | null;
  stop(): Promise<void>;
}

/** The parity suite's fakes and a fresh Session Metadata table, wired to an in-process Chat Service. */
export async function startInProcess(options: InProcessOptions = {}): Promise<InProcessStack> {
  const endpoint = inject('dynamodbEndpoint');
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  if ((options.table ?? 'created') === 'created') await createChatTable(endpoint, table);
  const client = new DynamoDBClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
  const sessionMetadata = new DynamoDBSessionMetadata(table, client);
  const agentcore = await new FakeAgentCore().listen();
  const sessionApi = await new FakeSessionApi().listen();
  const bedrock = await new FakeBedrock().listen();
  const cartridge: ChatServiceCartridge = {
    corsOrigins: [],
    agentDocuments: {
      agentIdentity: { name: 'Test Bot', character: 'A test agent', vibe: 'Plain', avatar: '' },
      soul: 'Be brief.',
    },
    models: [
      { key: 'quick', label: 'Quick', provider: 'anthropic' },
      { key: 'thorough', label: 'Thorough', description: 'Slower, more careful', provider: 'anthropic' },
    ],
    accountModels: async () => [{ key: 'plan', label: 'Plan', provider: 'openai' }],
    browserEventName: 'test:browser-live-view',
    routes: new Hono(),
    requester: async (c) => ({ owner: c.req.header('x-test-owner') ?? OWNER }),
    filingUserId: (owner) => `filed-${owner}`,
    scheduledRequester: async (owner) => ({ owner }),
    signInNeeded: async () => null,
    invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps } }),
    credentialProps: [],
    authorizeBrowserLiveView: async () => undefined,
    warmSession: async () => undefined,
    ...options.cartridge,
  };
  const config: ChatServiceConfig = {
    agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agentcore.url },
    localHarnessUrl: null,
    corsOrigins: null,
    region: 'us-east-1',
    agentCoreEndpoint: agentcore.url,
    browserId: 'aws.browser.v1',
    sessionApi: { localUrl: sessionApi.url },
    warmupTimeoutMs: 10_000,
    turnSummaryModel: { region: 'us-east-1', url: `${bedrock.url}/model/summary/converse` },
    ...options.config,
  };
  const aws = { region: 'us-east-1', endpoint, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } };
  const runs = options.scheduled === true ? await createScheduledRuns(endpoint) : null;
  let stopped = false;
  const queue = runs && sqsRunQueue(runs.queueUrl, new SQSClient(aws));
  // A stopped stack's poller waits forever rather than polling a queue no test reads.
  const runQueue: RunQueue | null = queue && {
    receive: (signal) => (stopped ? new Promise(() => undefined) : queue.receive(signal)),
    delete: (receipt) => queue.delete(receipt),
  };
  let history: AccountHistory | undefined;
  const app = createChatService(
    (hooks) => {
      history = hooks;
      return cartridge;
    },
    config,
    sessionMetadata,
    new DynamoDBAgentDocuments(table, client),
    undefined,
    runs && runQueue && { tasks: new ScheduledTasks(table, runs, client, new SchedulerClient(aws)), queue: runQueue, draining: options.scheduledDraining ?? (async () => false) },
  );
  return {
    app,
    history: history as AccountHistory,
    agentcore,
    sessionApi,
    bedrock,
    sessionMetadata,
    table: { name: table, client },
    scheduler: runs && new SchedulerView(endpoint, runs),
    async stop() {
      stopped = true;
      await Promise.all([agentcore.close(), sessionApi.close(), bedrock.close()]);
    },
  };
}
