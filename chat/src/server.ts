import { TurnQuota, TurnQuotaExceeded } from './turn-quota.js';
import { startChatTracing } from './tracing.js';
import { chatTable } from './config.js';
import { TurnIdentity, turnIdentityConfigFromEnv, turnIdentityRoutes, type TurnIdentityConfig } from './turn-identity.js';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { Hono, type Context } from 'hono';
import { DynamoDBAgentDocuments, type AgentDocuments } from './agent-documents.js';
import { awsFetch, presignAwsUrl } from './aws.js';
import { HttpError, type AccountHistory, type CartridgeFactory, type ChatServiceCartridge } from './cartridge.js';
import { sleepComputersAtTaskStop } from './task-stop.js';
import { cors, LOCAL_UI_ORIGINS } from './cors.js';
import { sessionOperations } from './sessions.js';
import { purgeQueue } from './purges.js';
import { sweepEvery } from './task-drain.js';
import { sessionLifecycle } from './session-lifecycle.js';
import { sessionApi, type SessionApi, type SessionApiConfig } from './session-api.js';
import { DynamoDBSessionMetadata, SessionDispatchPendingError, type SessionMetadata, type SessionPurge } from './session-metadata.js';
import { ScheduledTasks, schedulerConfigFromEnv } from './scheduled-tasks.js';
import { ssmParkHistory, type ParkHistory } from './park-history.js';
import { isUserRequest, ProductionActivity } from './production-activity.js';
import { ecsTaskDraining, pollScheduledRuns, runScheduledTask, sqsRunQueue, type RunQueue } from './scheduled-runs.js';
import { bedrockTurnSummarizer, reportUnsavedTurnSummaries, turnSummaryModelFromEnv, type TurnSummaryModel } from './turn-summaries.js';
import { agentCoreEndpointFromEnv, agentCoreUpstream, localAgentUpstream, type AgentCoreRuntime } from './upstream.js';
import { turnRoutes } from './turn-routes.js';
import { temporaryRoutes } from './temporary-routes.js';
import { accountRoutes } from './account-routes.js';

const LIVE_VIEW_URL_EXPIRES_SECONDS = 300;

export interface ChatServiceConfig {
  temporaryChatSecret?: string;
  /** Unset: no per-Turn user identity, and no OIDC discovery. */
  turnIdentity?: TurnIdentityConfig;
  /** Unset: Turns get 503 and warmup is skipped. */
  agentCore: AgentCoreRuntime | null;
  /** Set: Turns go to this local Harness over plain HTTP instead of AgentCore. */
  localHarnessUrl: string | null;
  /** BOTCUBE_CORS_ORIGINS; null keeps the Cartridge's defaults. */
  corsOrigins: string[] | null;
  /** The AgentCore region and data-plane endpoint, for browser live-view URLs. */
  region: string;
  agentCoreEndpoint: string;
  /** AGENTCORE_BROWSER_ID: the browser whose live views are presigned unless the Cartridge names another. */
  browserId: string;
  sessionApi: SessionApiConfig;
  /** How long a warmup waits for the Runtime to answer. */
  warmupTimeoutMs: number;
  /** The model that summarizes each finished Turn for the Activity. */
  turnSummaryModel: TurnSummaryModel;
}

function configFromEnv(env: NodeJS.ProcessEnv): ChatServiceConfig {
  const { region, endpoint } = agentCoreEndpointFromEnv(env);
  const origins = env.BOTCUBE_CORS_ORIGINS;
  const localSessionApiUrl = env.BOTCUBE_LOCAL_SESSION_API_URL?.replace(/\/+$/, '');
  const turnIdentity = turnIdentityConfigFromEnv(env);
  return {
    agentCore: env.AGENTCORE_RUNTIME_ARN ? { arn: env.AGENTCORE_RUNTIME_ARN, region, endpoint } : null,
    localHarnessUrl: env.BOTCUBE_LOCAL_HARNESS_URL?.replace(/\/+$/, '') || null,
    corsOrigins: origins
      ? origins
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : null,
    region,
    agentCoreEndpoint: endpoint,
    browserId: env.AGENTCORE_BROWSER_ID || 'aws.browser.v1',
    sessionApi: env.BOTCUBE_SESSION_API_FUNCTION_ARN
      ? { functionArn: env.BOTCUBE_SESSION_API_FUNCTION_ARN, region, ...(env.AWS_ENDPOINT_URL_LAMBDA ? { endpoint: env.AWS_ENDPOINT_URL_LAMBDA } : {}) }
      : localSessionApiUrl
        ? { localUrl: localSessionApiUrl }
        : null,
    warmupTimeoutMs: 60_000,
    ...(env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ? { temporaryChatSecret: env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET } : {}),
    turnSummaryModel: turnSummaryModelFromEnv(env, region),
    ...(turnIdentity ? { turnIdentity } : {}),
  };
}

/** One URL path segment, with every reserved character (RFC 3986 `!'()*` too) percent-encoded. */
const pathSegment = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function createChatService(
  cartridgeFactory: CartridgeFactory,
  config: ChatServiceConfig,
  sessionMetadata: SessionMetadata,
  agentDocuments: AgentDocuments,
  invokeSessionApi: SessionApi = sessionApi(config.sessionApi),
  scheduled: { tasks: ScheduledTasks; queue: RunQueue; draining: () => Promise<boolean>; parkHistory?: ParkHistory | undefined; onClose?: (stop: () => void) => void } | null = null,
  turnQuota: TurnQuota | null = null,
  draining: () => Promise<boolean> = scheduled?.draining ?? (async () => false),
): Hono {
  const scheduledTasks = scheduled?.tasks ?? null;
  const runtime = config.agentCore && agentCoreUpstream(config.agentCore);
  const upstream = config.localHarnessUrl ? sessionLifecycle(localAgentUpstream(config.localHarnessUrl)) : runtime && sessionLifecycle(runtime, runtime.stop);
  const purge = purgeQueue(invokeSessionApi, (owner) => cartridge.filingUserId(owner), async (session) => {
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
  const purgeSessions = (sessions: SessionPurge[], wait = false) => {
    if (sessions.length > 0 && upstream === null) throw new HttpError(503, 'The Session Runtime is not configured');
    upstream?.fence(sessions);
    return wait ? purge.wait(sessions) : purge(sessions);
  };
  let recoveryError: unknown = new Error('Session purge recovery has not completed');
  const recoverPurges = async () => {
    try {
      await purgeSessions(await sessionMetadata.pendingPurges());
      await cartridge.recoverAccountDeletions?.();
      recoveryError = undefined;
    } catch (error) {
      recoveryError = error;
      console.error('Session purge failed; durable cleanup recovery failed', error);
    }
  };
  const sessions = sessionOperations(sessionMetadata, invokeSessionApi, agentDocuments, scheduledTasks, purgeSessions, (owner) => cartridge.filingUserId(owner));
  const history: AccountHistory = {
    delete: sessions.removeOwner,
    transfer: async (source, destination) => {
      await sessionMetadata.transferOwner(source, destination);
      await scheduledTasks?.transfer(source, destination);
    },
    owns: (owner, sessionId) => sessionMetadata.owns(owner, sessionId),
    ownsMainChat: (owner, sessionId) => sessionMetadata.ownsMainChat(owner, sessionId),
  };
  const cartridge = cartridgeFactory(history);
  const initialRecovery = recoverPurges();
  void initialRecovery.then(() => sweepEvery(120_000, draining, recoverPurges));
  const summarizeTurn = bedrockTurnSummarizer(config.turnSummaryModel);
  const turnIdentity = config.turnIdentity === undefined ? null : new TurnIdentity(config.turnIdentity);
  const app = new Hono();
  let scheduledRunsUnavailable = false;
  if (scheduled !== null) {
    const deps = { cartridge, sessionMetadata, agentDocuments, invokeSessionApi, scheduledTasks: scheduled.tasks, upstream, summarizeTurn, turnIdentity, parkHistory: scheduled.parkHistory };
    const stop = pollScheduledRuns(scheduled.queue, (message) => runScheduledTask(deps, message), scheduled.draining, () => {
      scheduledRunsUnavailable = true;
    }, async () => {
      for (const { owner, taskId, error } of await scheduled.tasks.retireExpired()) {
        console.error('Scheduled task retirement failed', { owner, taskId }, error);
      }
    });
    scheduled.onClose?.(stop);
  }

  app.use(cors(config.corsOrigins ?? cartridge.corsOrigins ?? LOCAL_UI_ORIGINS));
  // Cloudflare replaces an origin's 502 or 504 with its own page, which has no CORS headers, so the browser would
  // read only a network error; a 503 keeps the error's body and headers.
  app.use(async (c, next) => {
    await next();
    if (c.res.status === 502 || c.res.status === 504) c.res = new Response(c.res.body, { status: 503, headers: c.res.headers });
  });
  app.onError((error, c) => {
    if (!(error instanceof HttpError) || error.cause !== undefined) {
      console.error(`${c.req.method} ${c.req.path} failed`, error);
    }
    if (error instanceof TurnQuotaExceeded) c.header('Retry-After', String(error.retryAfter));
    if (error instanceof SessionDispatchPendingError) return c.json({ detail: error.message, status: 'pending' }, 503);
    if (error instanceof HttpError) return c.json({ detail: error.detail, ...(error.code === undefined ? {} : { code: error.code }) }, error.status as 400);
    return c.text('Internal Server Error', 500);
  });
  if (turnIdentity !== null) app.route('/', turnIdentityRoutes(turnIdentity));
  app.route('/', cartridge.routes);

  if (config.temporaryChatSecret !== undefined) temporaryRoutes(app, config.temporaryChatSecret, cartridge, upstream, turnQuota);

  turnRoutes(app, cartridge, sessionMetadata, agentDocuments, upstream, config, summarizeTurn, turnIdentity, turnQuota);

  app.get('/health', async (c) => {
    await initialRecovery;
    try {
      await sessionMetadata.checkHealth();
    } catch (error) {
      console.error('Session Metadata readiness probe failed', error);
      throw new HttpError(503, 'Session Metadata storage is unavailable');
    }
    if (scheduledRunsUnavailable) throw new HttpError(503, 'Scheduled runs are unavailable');
    if (recoveryError !== undefined) throw new HttpError(503, 'Session purge recovery is unavailable');
    return c.json({ status: 'ok' });
  });

  app.get('/ping', (c) => {
    if (scheduledRunsUnavailable) throw new HttpError(503, 'Scheduled runs are unavailable');
    return c.json({ status: 'Healthy' });
  });

  accountRoutes(app, cartridge, sessionMetadata, agentDocuments, invokeSessionApi, sessions, scheduledTasks, upstream !== null);

  app.get('/browser-live-view-url', async (c) => {
    const sessionId = c.req.query('session_id');
    if (sessionId === undefined) {
      return c.json({ detail: [{ type: 'missing', loc: ['query', 'session_id'], msg: 'Field required' }] }, 422);
    }
    if (!sessionId.trim()) throw new HttpError(422, 'session_id must not be blank');
    const browserId = (await cartridge.authorizeBrowserLiveView(sessionId, c)) || config.browserId;
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
    const browserId = (await cartridge.authorizeBrowserLiveView(sessionId, c)) || config.browserId;
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

  return app;
}

function parkHistoryFromEnv(env: NodeJS.ProcessEnv): ParkHistory | undefined {
  const parameter = env.BOTCUBE_PARK_STATE_PARAMETER;
  if (parameter === undefined) return undefined;
  const productName = env.BOTCUBE_PRODUCT_NAME;
  if (!productName) throw new Error('BOTCUBE_PARK_STATE_PARAMETER needs BOTCUBE_PRODUCT_NAME, the name a skipped run says was paused');
  return ssmParkHistory(parameter, productName);
}

/** Serve the Chat Service with this Cartridge, configured from the environment, on $PORT. */
export function serveChatService(cartridge: CartridgeFactory, env: NodeJS.ProcessEnv = process.env): ServerType {
  const config = configFromEnv(env);
  if (config.agentCore === null && config.localHarnessUrl === null) {
    console.warn('AGENTCORE_RUNTIME_ARN is not set; agent runs (POST /) return 503 and warmup is skipped until it is configured.');
  }
  const table = chatTable(env);
  const scheduler = schedulerConfigFromEnv(env);
  const activity = env.BOTCUBE_REPORT_ACTIVITY === 'true' ? new ProductionActivity() : null;
  const metadata = new DynamoDBSessionMetadata(table);
  const draining = ecsTaskDraining(env.ECS_CONTAINER_METADATA_URI_V4);
  let stopScheduledRuns: (() => void) | undefined;
  let built: ChatServiceCartridge | undefined;
  const app = createChatService(
    (history) => (built = cartridge(history)),
    config,
    activity?.observe(metadata) ?? metadata,
    new DynamoDBAgentDocuments(table),
    sessionApi(config.sessionApi),
    scheduler && {
      tasks: new ScheduledTasks(table, scheduler),
      queue: sqsRunQueue(scheduler.queueUrl),
      draining,
      parkHistory: parkHistoryFromEnv(env),
      onClose: (stop) => { stopScheduledRuns = stop; },
    },
    new TurnQuota(table),
    draining,
  );
  const port = Number(env.PORT || 8123);
  // ws types `noServer` as `boolean | undefined`, which exactOptionalPropertyTypes keeps from matching.
  const websocket = { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike };
  const tracing = startChatTracing(env);
  let shutdown: Promise<void> | undefined;
  const stopTracing = () => shutdown ??= tracing?.shutdown() ?? Promise.resolve();
  const webOrigins = config.corsOrigins ?? built?.corsOrigins ?? LOCAL_UI_ORIGINS;
  const automation = (env.BOTCUBE_AUTOMATION_USER_AGENTS ?? '').split(',').filter(Boolean);
  const fetch: typeof app.fetch = (request, ...rest) => {
    if (activity !== null && isUserRequest(request, webOrigins, automation)) activity.userRequest();
    return app.fetch(request, ...rest);
  };
  activity?.report(table);
  const server = serve({ fetch, port, hostname: env.BOTCUBE_CHAT_HOST || '0.0.0.0', websocket }, () =>
    console.log(`Chat Service listening on :${port}`),
  );
  const sleepAgentComputers = built?.sleepAgentComputers?.bind(built);
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
    stopScheduledRuns?.();
    void stopTracing().catch((error: unknown) => { console.error('Chat tracing shutdown failed', error); });
    unregisterTaskStop?.();
    if (!taskStopping) process.off('exit', reportUnsavedTurnSummaries);
  });
  return server;
}
