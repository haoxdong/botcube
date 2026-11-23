import { TurnQuota, TurnQuotaExceeded } from './turn-quota.js';
import { startChatTracing } from './tracing.js';
import { startProxyRelayForConfig } from './proxy-relay.js';
import { chatTable } from './config.js';
import { loadBotSettings } from 'botcube-config/load';
import { assumeRoleAwsAccess } from './turn-credentials.js';
import { TurnIdentity, turnIdentityConfigFromEnv, turnIdentityRoutes, type TurnIdentityConfig } from './turn-identity.js';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { Hono, type Context } from 'hono';
import { DynamoDBAgentDocuments, type AgentDocuments } from './agent-documents.js';
import { awsFetch, presignAwsUrl } from './aws.js';
import { cspReportRoutes } from './csp-reports.js';
import type { AccountHistory } from './account-history.js';
import { HttpError } from './http-error.js';
import { sleepComputersAtTaskStop } from './task-stop.js';
import { cors } from './cors.js';
import { sessionAccessError, sessionOperations } from './sessions.js';
import { purgeQueue } from './purges.js';
import { sweepEvery } from './task-drain.js';
import { sessionLifecycle } from './session-lifecycle.js';
import { sessionApi, type SessionApi, type SessionApiConfig } from './session-api.js';
import { DynamoDBSessionMetadata, SessionDispatchPendingError, type SessionMetadata, type SessionPurge } from './session-metadata.js';
import type { ScheduledTasks } from './scheduled-tasks.js';
import { chatScheduling } from './schedules.js';
import type { TableSchedules } from './table-schedules.js';
import { configAdapters, type ConfigAdapters, type AwsAccessAdapter } from './config-adapters.js';
import { ssmParkHistory, type ParkHistory } from './park-history.js';
import { isUserRequest, ProductionActivity } from './production-activity.js';
import { ecsTaskDraining, pollScheduledRuns, runScheduledTask, type RunQueue } from './scheduled-runs.js';
import { reportUnsavedTurnSummaries, turnSummarizer, turnSummaryModel, type TurnSummaryModel } from './turn-summaries.js';
import { harnessBearer, type ChatHarnessAuth } from './harness-auth.js';
import { agentCoreEndpointFromEnv, agentCoreUpstream, localAgentUpstream, type AgentCoreRuntime } from './upstream.js';
import { turnRoutes } from './turn-routes.js';
import { accountRoutes } from './account-routes.js';
import { userTokenRoutes } from './user-token.js';
import { stockChatService, type StockChat, type StockOptions } from './stock.js';

const LIVE_VIEW_URL_EXPIRES_SECONDS = 300;

export interface ChatServiceConfig {
  /** Unset: no per-Turn user identity, no signed user token, and no OIDC discovery. */
  turnIdentity?: TurnIdentityConfig;
  /** The BotCube Config's `awsAccess` adapter; unset is `web-identity`, the Turn identity's own token. */
  awsAccess?: AwsAccessAdapter;
  /** Unset: Turns get 503 and warmup is skipped. */
  agentCore: AgentCoreRuntime | null;
  /** How Turns authenticate to the Harness; unset is SigV4. */
  harnessAuth?: ChatHarnessAuth;
  /** Set: Turns go to this local Harness over plain HTTP instead of AgentCore. */
  localHarnessUrl: string | null;
  /** The web UI's origins, which CORS allows: `allowedOrigins` of the BotCube Config. */
  corsOrigins: readonly string[];
  /** The AgentCore region and data-plane endpoint, for browser live-view URLs. */
  region: string;
  agentCoreEndpoint: string;
  /** AGENTCORE_BROWSER_ID: the browser whose live views are presigned unless the bot names another. */
  browserId: string;
  sessionApi: SessionApiConfig;
  /** How long a warmup waits for the Runtime to answer. */
  warmupTimeoutMs: number;
  /** The model that summarizes each finished Turn for the Activity. */
  turnSummaryModel: TurnSummaryModel;
}

function configFromEnv(env: NodeJS.ProcessEnv, adapters: ConfigAdapters): ChatServiceConfig {
  const { region, endpoint } = agentCoreEndpointFromEnv(env);
  const localSessionApiUrl = env.BOTCUBE_LOCAL_SESSION_API_URL?.replace(/\/+$/, '');
  const turnIdentity = turnIdentityConfigFromEnv(env);
  return {
    agentCore: env.AGENTCORE_RUNTIME_ARN ? { arn: env.AGENTCORE_RUNTIME_ARN, region, endpoint } : null,
    harnessAuth: adapters.harnessAuth,
    localHarnessUrl: env.BOTCUBE_LOCAL_HARNESS_URL?.replace(/\/+$/, '') || null,
    corsOrigins: adapters.corsOrigins,
    region,
    agentCoreEndpoint: endpoint,
    browserId: env.AGENTCORE_BROWSER_ID || 'aws.browser.v1',
    sessionApi: env.BOTCUBE_SESSION_API_FUNCTION_ARN
      ? { functionArn: env.BOTCUBE_SESSION_API_FUNCTION_ARN, region, ...(env.AWS_ENDPOINT_URL_LAMBDA ? { endpoint: env.AWS_ENDPOINT_URL_LAMBDA } : {}) }
      : localSessionApiUrl
        ? { localUrl: localSessionApiUrl }
        : null,
    warmupTimeoutMs: 60_000,
    turnSummaryModel: turnSummaryModel(adapters.models, env, region),
    ...(turnIdentity ? { turnIdentity } : {}),
    awsAccess: adapters.awsAccess,
  };
}

/** One URL path segment, with every reserved character (RFC 3986 `!'()*` too) percent-encoded. */
const pathSegment = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The environment the stock Chat reads its BotCube Config and External Services from, and the options it is built with. */
export type ChatDeployment = { env: NodeJS.ProcessEnv } & StockOptions;

export interface ChatService {
  readonly app: Hono;
  /** BotCube's own Chat, as the Chat Service built it. */
  readonly chat: StockChat;
  /** The account-history hooks the Chat Service handed the Chat. */
  readonly history: AccountHistory;
}

export function createChatService(
  deployment: ChatDeployment,
  config: ChatServiceConfig,
  sessionMetadata: SessionMetadata,
  agentDocuments: AgentDocuments,
  invokeSessionApi: SessionApi = sessionApi(config.sessionApi),
  scheduled: { tasks: ScheduledTasks; queue: RunQueue; poll?: TableSchedules | undefined; draining: () => Promise<boolean>; parkHistory?: ParkHistory | undefined; onClose?: (stop: () => void) => void } | null = null,
  turnQuota: TurnQuota | null = null,
  draining: () => Promise<boolean> = scheduled?.draining ?? (async () => false),
): ChatService {
  const scheduledTasks = scheduled?.tasks ?? null;
  const turnIdentity = config.turnIdentity === undefined ? null : new TurnIdentity(config.turnIdentity);
  const bearer = harnessBearer(config.harnessAuth ?? { kind: 'sigv4' }, turnIdentity);
  const runtime = config.agentCore && agentCoreUpstream(config.agentCore, { bearer });
  const upstream = config.localHarnessUrl ? sessionLifecycle(localAgentUpstream(config.localHarnessUrl, { bearer })) : runtime && sessionLifecycle(runtime, runtime.stop);
  const purge = purgeQueue(invokeSessionApi, (owner) => bot.filingUserId(owner), async (session) => {
    if (upstream === null) throw new HttpError(503, 'The Session Runtime is not configured');
    await sessionMetadata.settleExpiredDispatches(session);
    if (config.localHarnessUrl) {
      await upstream.stop(session);
      await sessionMetadata.assertNoDispatch(session);
      return undefined;
    }
    upstream.restoreFailedDispatch(session, await sessionMetadata.rejectedDispatches(session, upstream.runtimeTarget));
    await sessionMetadata.assertNoDispatch(session, upstream.failedDispatchTokens(session));
    const settled = await upstream.settleFailedDispatch(session);
    await sessionMetadata.assertNoDispatch(session);
    if (settled) return undefined;
    return upstream.stop(session);
  }, undefined, (session) => sessionMetadata.completePurge(session), (session) => sessionMetadata.retainUnprovedPurge(session), draining);
  const fenceSessions = (sessions: SessionPurge[]) => {
    if (sessions.length > 0 && upstream === null) throw new HttpError(503, 'The Session Runtime is not configured');
    upstream?.fence(sessions);
  };
  const purgeSessions = (sessions: SessionPurge[], wait = false) => {
    fenceSessions(sessions);
    return wait ? purge.wait(sessions) : purge(sessions);
  };
  let recoveryError: unknown = new Error('Session purge recovery has not completed');
  const recoverPurges = async () => {
    try {
      const sessions = await sessionMetadata.pendingPurges();
      fenceSessions(sessions);
      purge.recover(sessions);
      await bot.recoverAccountDeletions?.();
      recoveryError = undefined;
    } catch (error) {
      recoveryError = error;
      console.error('Session purge failed; durable cleanup recovery failed', error);
    }
  };
  const sessions = sessionOperations(sessionMetadata, invokeSessionApi, agentDocuments, scheduledTasks, purgeSessions, (owner) => bot.filingUserId(owner));
  const history: AccountHistory = {
    delete: sessions.removeOwner,
    transfer: async (source, destination) => {
      await sessionMetadata.transferOwner(source, destination);
      await scheduledTasks?.transfer(source, destination);
    },
    owns: (owner, sessionId) => sessionMetadata.owns(owner, sessionId),
    ownsMainChat: (owner, sessionId) => sessionMetadata.ownsMainChat(owner, sessionId),
  };
  const bot = stockChatService(deployment.env, deployment)(history);
  const initialRecovery = recoverPurges();
  void initialRecovery.then(() => sweepEvery(120_000, draining, recoverPurges));
  const summarizeTurn = turnSummarizer(config.turnSummaryModel);
  const awsAccess = config.awsAccess?.kind === 'assume-role' ? assumeRoleAwsAccess(config.awsAccess.roleArn) : turnIdentity;
  const app = new Hono();
  let scheduledRunsUnavailable = false;
  if (scheduled !== null) {
    const deps = { bot, sessionMetadata, agentDocuments, invokeSessionApi, scheduledTasks: scheduled.tasks, upstream, stopScheduledRuntime: config.localHarnessUrl ? undefined : runtime?.stop, summarizeTurn, turnIdentity: awsAccess, userTokens: turnIdentity, parkHistory: scheduled.parkHistory };
    const unavailable = () => { scheduledRunsUnavailable = true; };
    const stopRuns = pollScheduledRuns(scheduled.queue, (message) => runScheduledTask(deps, message), scheduled.draining, unavailable, async () => {
      for (const { owner, taskId, error } of await scheduled.tasks.retireExpired()) {
        console.error('Scheduled task retirement failed', { owner, taskId }, error);
      }
    });
    const stopPoll = scheduled.poll?.start(unavailable);
    scheduled.onClose?.(() => {
      stopRuns();
      stopPoll?.();
    });
  }

  app.use(cors(config.corsOrigins));
  // Cloudflare replaces an origin's 502 or 504 with its own page, which has no CORS headers, so the browser would
  // read only a network error; a 503 keeps the error's body and headers.
  app.use(async (c, next) => {
    await next();
    if (c.res.status === 502 || c.res.status === 504) c.res = new Response(c.res.body, { status: 503, headers: c.res.headers });
  });
  app.onError((cause, c) => {
    const error = sessionAccessError(cause);
    if (!(error instanceof HttpError) || error.cause !== undefined) {
      console.error(`${c.req.method} ${c.req.path} failed`, error);
    }
    if (error instanceof TurnQuotaExceeded) c.header('Retry-After', String(error.retryAfter));
    if (error instanceof SessionDispatchPendingError) return c.json({ detail: error.message, status: 'pending' }, 503);
    if (error instanceof HttpError) return c.json({ detail: error.detail, ...(error.code === undefined ? {} : { code: error.code }) }, error.status as 400);
    return c.text('Internal Server Error', 500);
  });
  if (turnIdentity !== null) app.route('/', turnIdentityRoutes(turnIdentity));
  if (turnIdentity !== null) app.route('/', userTokenRoutes(turnIdentity, (c) => bot.requester(c)));
  app.route('/', bot.routes);


  turnRoutes(app, {
    bot,
    stores: { sessionMetadata, agentDocuments },
    harness: { upstream, warmupTimeoutMs: config.warmupTimeoutMs },
    turns: { summarizeTurn, turnQuota, awsAccess, userTokens: turnIdentity },
  });

  const checkReadiness = async () => {
    await initialRecovery;
    try {
      await sessionMetadata.checkHealth();
    } catch (error) {
      console.error('Session Metadata readiness probe failed', error);
      throw new HttpError(503, 'Session Metadata storage is unavailable');
    }
    if (scheduledRunsUnavailable) throw new HttpError(503, 'Scheduled runs are unavailable');
    if (recoveryError !== undefined) throw new HttpError(503, 'Session purge recovery is unavailable');
  };
  app.get('/health', async (c) => {
    await checkReadiness();
    return c.json({ status: 'ok' });
  });
  app.on(['GET', 'POST'], '/production/wake', async (c) => {
    c.header('Cache-Control', 'no-store');
    await checkReadiness();
    return c.json({ state: 'live' });
  });

  cspReportRoutes(app);

  app.get('/ping', (c) => {
    if (scheduledRunsUnavailable) throw new HttpError(503, 'Scheduled runs are unavailable');
    return c.json({ status: 'Healthy' });
  });

  accountRoutes(app, bot, sessionMetadata, agentDocuments, invokeSessionApi, sessions, scheduledTasks, upstream !== null);

  app.get('/browser-live-view-url', async (c) => {
    const sessionId = c.req.query('session_id');
    if (sessionId === undefined) {
      return c.json({ detail: [{ type: 'missing', loc: ['query', 'session_id'], msg: 'Field required' }] }, 422);
    }
    if (!sessionId.trim()) throw new HttpError(422, 'session_id must not be blank');
    const browserId = (await bot.authorizeBrowserLiveView(sessionId, c)) || config.browserId;
    const url =
      `${config.agentCoreEndpoint}/browser-streams/${pathSegment(browserId)}` +
      `/sessions/${pathSegment(sessionId)}/live-view`;
    return c.json({
      signedUrl: await presignAwsUrl('bedrock-agentcore', config.region, url, LIVE_VIEW_URL_EXPIRES_SECONDS),
    });
  });

  // Take-over: the user drives the browser and the agent's automation stream is
  // shut off until the user hands it back (the take-control toggle, ADR 0077).
  const browserControl = (streamStatus: 'DISABLED' | 'ENABLED') => async (c: Context) => {
    const sessionId = c.req.query('session_id') ?? '';
    if (!sessionId.trim()) throw new HttpError(422, 'session_id must not be blank');
    const browserId = (await bot.authorizeBrowserLiveView(sessionId, c)) || config.browserId;
    const url = new URL(`${config.agentCoreEndpoint}/browsers/${pathSegment(browserId)}/sessions/streams/update`);
    url.searchParams.set('sessionId', sessionId);
    const response = await awsFetch('bedrock-agentcore', config.region, url.toString(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamUpdate: { automationStreamUpdate: { streamStatus } } }),
    });
    if (!response.ok) throw new HttpError(502, `AgentCore refused the browser control change: HTTP ${response.status}`);
    return c.json({ status: 'ok' });
  };
  app.post('/browser-take-over', browserControl('DISABLED'));
  app.post('/browser-hand-back', browserControl('ENABLED'));

  return { app, chat: bot, history };
}

function parkHistory(parameter: string, productName: string | undefined): ParkHistory {
  if (productName === undefined) throw new Error("BOTCUBE_PARK_STATE_PARAMETER needs the bot settings' productName, the name a skipped run says was paused");
  return ssmParkHistory(parameter, productName);
}

/** Serve the Chat Service, configured from the environment and the BotCube Config it names, on $PORT. */
export function serveChatService(env: NodeJS.ProcessEnv = process.env, options: StockOptions = {}): ServerType {
  const adapters = configAdapters(env);
  // Listening first: every client, and the collector sidecar beside this container, sends through it.
  const proxyRelay = startProxyRelayForConfig(adapters.proxy, env);
  proxyRelay?.catch((error: unknown) => {
    console.error('The proxy relay could not start', error);
    process.exit(1);
  });
  const config = configFromEnv(env, adapters);
  if (config.agentCore === null && config.localHarnessUrl === null) {
    console.warn('AGENTCORE_RUNTIME_ARN is not set; agent runs (POST /) return 503 and warmup is skipped until it is configured.');
  }
  const table = chatTable(env);
  const scheduling = chatScheduling(adapters.schedules, env, table);
  const activity = new ProductionActivity();
  const metadata = new DynamoDBSessionMetadata(table);
  const draining = ecsTaskDraining(env.ECS_CONTAINER_METADATA_URI_V4);
  const parkState = env.BOTCUBE_PARK_STATE_PARAMETER;
  let stopScheduledRuns: (() => void) | undefined;
  const { app, chat } = createChatService(
    { ...options, env },
    config,
    activity.observe(metadata),
    new DynamoDBAgentDocuments(table),
    sessionApi(config.sessionApi),
    scheduling && {
      ...scheduling,
      draining,
      parkHistory: parkState === undefined ? undefined : parkHistory(parkState, loadBotSettings('/bot/bot.yaml').productName),
      onClose: (stop) => { stopScheduledRuns = stop; },
    },
    new TurnQuota(table),
    draining,
  );
  const port = Number(env.PORT || 8123);
  // ws types `noServer` as `boolean | undefined`, which exactOptionalPropertyTypes keeps from matching.
  const websocket = { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike };
  const tracing = startChatTracing(adapters.telemetry, env);
  const startupCredentials = [
    ...(config.turnSummaryModel.kind === 'openai-compatible' ? [config.turnSummaryModel.endpoint.credential] : []),
    ...(tracing?.credential ? [tracing.credential] : []),
    ...(chat.startupCredentials ?? []),
  ];
  Promise.all(startupCredentials.map((source) => source.get())).catch((error: unknown) => {
    console.error(`The Chat Service could not read a credential at startup: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  let shutdown: Promise<void> | undefined;
  const stopTracing = () => shutdown ??= tracing?.shutdown() ?? Promise.resolve();
  const fetch: typeof app.fetch = (request, ...rest) => {
    if (isUserRequest(request, config.corsOrigins, adapters.automationUserAgents)) activity.userRequest();
    return app.fetch(request, ...rest);
  };
  activity.report(table);
  const server = serve({ fetch, port, hostname: '0.0.0.0', websocket }, () =>
    console.log(`Chat Service listening on :${port}`),
  );
  const sleepAgentComputers = chat.sleepAgentComputers?.bind(chat);
  let taskStopping = false;
  const unregisterTaskStop = (sleepAgentComputers || tracing) && sleepComputersAtTaskStop(() => {
    taskStopping = true;
    stopScheduledRuns?.();
    const sleep = sleepAgentComputers?.() ?? { slept: Promise.resolve([]), sleeps: [] };
    if (tracing === undefined) return sleep;
    const drained = new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => error ? reject(error) : resolve());
    }).then(stopTracing);
    return { slept: Promise.all([sleep.slept, drained]).then(([sessions]) => sessions), sleeps: [...sleep.sleeps, drained] };
  });
  process.on('exit', reportUnsavedTurnSummaries);
  server.once('close', () => {
    void proxyRelay?.then((relay) => relay.close(), () => undefined);
    stopScheduledRuns?.();
    void stopTracing().catch((error: unknown) => { console.error('Chat tracing shutdown failed', error); });
    unregisterTaskStop?.();
    if (!taskStopping) process.off('exit', reportUnsavedTurnSummaries);
  });
  return server;
}
