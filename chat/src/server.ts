import { TurnTiming } from './turn-timing.js';
import { chatTable, positiveInteger } from './config.js';
import { TurnIdentity, forwardTurnIdentity, turnIdentityConfigFromEnv, turnIdentityRoutes, type TurnIdentityConfig } from './turn-identity.js';
import type { TurnFailure } from './session-metadata.js';
import type { RunAgentInput } from '@ag-ui/client';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { Hono, type Context } from 'hono';
import {
  agentDocumentEdit,
  agentIdentity,
  DynamoDBAgentDocuments,
  memoryLine,
  soul,
  type AgentDocuments,
} from './agent-documents.js';
import { awsFetch, presignAwsUrl } from './aws.js';
import { HttpError, type AccountHistory, type AgentModel, type CartridgeFactory, type ChatServiceCartridge, type Requester } from './cartridge.js';
import { sleepComputersAtTaskStop } from './task-stop.js';
import { cors, LOCAL_UI_ORIGINS } from './cors.js';
import { BROWSER_LIVE_VIEW_EVENT } from './live-view.js';
import { picture, pictureUrl } from './pictures.js';
import { accountDefaultModel, accountModelList, namedModel, requireAllowedModel } from './models.js';
import { sessionOperations } from './sessions.js';
import { purgeQueue } from './purges.js';
import { sessionLifecycle } from './session-lifecycle.js';
import { sessionApi, type SessionApi, type SessionApiConfig } from './session-api.js';
import {
  DynamoDBSessionMetadata,
  SessionDeletedError,
  SessionDispatchPendingError,
  SessionNamespaceNotReadyError,
  trackedRuntime,
  SessionClaimError,
  SessionProviderError,
  SessionOpeningError,
  SessionBusyError,
  type SessionMetadata,
  type TurnActivity,
  type SessionPurge,
} from './session-metadata.js';
import {
  ScheduledTasks,
  schedulerConfigFromEnv,
  type ScheduledTask,
  type ScheduledTaskDefinition,
  type TaskChanges,
} from './scheduled-tasks.js';
import { isScheduledInstant } from './schedule-time.js';
import { ecsTaskDraining, pollScheduledRuns, runScheduledTask, sqsRunQueue, type RunQueue } from './scheduled-runs.js';
import { persistedTurnError, relayTurn, sseFrameData, stopTurn, turnCredentialGuard, turnCredentials, turnErrorDetails, type HeldIds } from './turn-stream.js';
import {
  bedrockTurnSummarizer,
  recordTurnSummary,
  reportUnsavedTurnSummaries,
  turnActivity,
  turnSummaryModelFromEnv,
  type TurnSummaryModel,
} from './turn-summaries.js';
import {
  agentCoreEndpointFromEnv,
  agentCoreUpstream,
  localAgentUpstream,
  harnessEndpointFromEnv,
  httpsHarnessUpstream,
  type HarnessEndpoint,
  type AgentCoreRuntime,
} from './upstream.js';

const WARMUP_SESSION_ID = '__warmup__000000000000000000000000';
/** The forwarded props BotCube's Credential Service, Agent Computer and Files bindings hand the Harness. */
const BOTCUBE_CREDENTIAL_PROPS = ['agentComputerCdpUrl', 'credentialServiceInvocationToken', 'credentialServiceUrl', 'files'];

function preparationFailure(error: unknown, credentials: readonly string[]): TurnFailure {
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'TURN_PREPARATION_FAILED', message: persistedTurnError(turnErrorDetails(message, credentials)) };
}

/** A warmup streams nothing unless the Harness fails to build the requester's agent: its RUN_ERROR message, if any. */
function runError(stream: string, credentials: readonly string[]): string | null {
  const guard = turnCredentialGuard(credentials);
  for (const frame of stream.split(/\r?\n\r?\n/)) {
    if (guard.leaks(frame, [])) return "The error body carried the Turn's credentials, so it was withheld";
    const data = sseFrameData(frame.split(/\r?\n/));
    let event: Record<string, unknown> | null;
    try {
      event = data === null ? null : (JSON.parse(data) as Record<string, unknown>);
    } catch {
      // JSON.parse errors quote the malformed input, which can carry a credential the guard cannot decode, such as a JSON-escaped one.
      throw new SyntaxError('The Runtime sent a warmup frame that is not JSON');
    }
    if (event?.type === 'RUN_ERROR') return String(event.message);
  }
  return null;
}

const LIVE_VIEW_URL_EXPIRES_SECONDS = positiveInteger(process.env, 'BOTCUBE_LIVE_VIEW_URL_EXPIRES_SECONDS', 300);

export interface ChatServiceConfig {
  /** Unset: no per-Turn user identity, and no OIDC discovery. */
  turnIdentity?: TurnIdentityConfig;
  /** Unset: Turns get 503 and warmup is skipped. */
  agentCore: AgentCoreRuntime | null;
  /** Set: Turns go to this local Harness over plain HTTP instead of AgentCore. */
  localHarnessUrl: string | null;
  harnessEndpoint?: HarnessEndpoint | null;
  connectTimeoutMs?: number;
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
    harnessEndpoint: harnessEndpointFromEnv(env),
    connectTimeoutMs: positiveInteger(env, 'BOTCUBE_HARNESS_CONNECT_TIMEOUT_MS', 30_000),
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
    // A warmup answers once the requester's agent is built, and a cold Sandbox took up to 22 s to take the invocation.
    warmupTimeoutMs: positiveInteger(env, 'BOTCUBE_WARMUP_TIMEOUT_MS', 60_000),
    turnSummaryModel: turnSummaryModelFromEnv(env, region),
    ...(turnIdentity ? { turnIdentity } : {}),
  };
}

/** One URL path segment, with every reserved character (RFC 3986 `!'()*` too) percent-encoded. */
const pathSegment = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const isRecord =(value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dropNulls = (value: unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) : value;

/**
 * A null optional field reads as absent and the input is forwarded without it;
 * nulls inside `state` and `forwardedProps` stay.
 */
function withoutOptionalNulls(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const input = dropNulls(body) as Record<string, unknown>;
  for (const key of ['messages', 'tools', 'context']) {
    if (Array.isArray(input[key])) input[key] = input[key].map(dropNulls);
  }
  if (Array.isArray(input.messages)) {
    input.messages = input.messages.map((message: unknown) =>
      isRecord(message) && Array.isArray(message.toolCalls)
        ? { ...message, toolCalls: message.toolCalls.map(dropNulls) }
        : message,
    );
  }
  return input;
}


/** The earlier message and tool-call IDs the client holds, removed from what the Harness receives. */
function takeHeldIds(forwardedProps: Record<string, unknown>): HeldIds {
  const ids = (prop: 'heldMessageIds' | 'heldToolCallIds'): string[] => {
    const value = forwardedProps[prop] ?? [];
    delete forwardedProps[prop];
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id !== '')) throw new HttpError(422, `${prop} must be a list of IDs`);
    return value;
  };
  return { messageIds: ids('heldMessageIds'), toolCallIds: ids('heldToolCallIds') };
}

const TASK_FIELDS = ['title', 'prompt', 'schedule', 'timezone'] as const;

type TaskFields = TaskChanges;

/** A task's definition fields from a request body: all of them, or (`required` false) any present. */
function taskDefinition(body: unknown, required: boolean): TaskFields {
  if (!isRecord(body)) throw new HttpError(422, 'Expected a JSON object');
  const definition: TaskFields = {};
  for (const field of TASK_FIELDS) {
    const value = body[field];
    if (value === undefined && !required) continue;
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, `${field} is required`);
    definition[field] = value.trim();
  }
  if ('maxRuns' in body || 'count' in body) throw new HttpError(422, 'Use startDate and endDate instead of a run count');
  for (const field of ['startDate', 'endDate'] as const) {
    const value = taskInstant(body[field], field, required);
    if (value !== undefined) definition[field] = value;
  }
  if (definition.schedule?.startsWith('at(') && (typeof definition.startDate === 'string' || typeof definition.endDate === 'string')) throw new HttpError(422, 'One-off tasks do not support startDate or endDate');
  if (typeof definition.startDate === 'string' && typeof definition.endDate === 'string' && Date.parse(definition.endDate) <= Date.parse(definition.startDate)) {
    throw new HttpError(422, 'endDate must be after startDate');
  }

  return definition;
}

function taskInstant(value: unknown, field: 'startDate' | 'endDate', required: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && !required) return null;
  if (!isScheduledInstant(value)) throw new HttpError(422, `${field} must be an ISO instant with a timezone`);
  return new Date(value).toISOString();
}

type Message = RunAgentInput['messages'][number];

/** A user message's text; any other message's is empty. */
function userText(message: Message): string {
  if (message.role !== 'user') return '';
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
  return text.trim();
}

/** The Session's title: the text of its first user message. */
function title(messages: RunAgentInput['messages']): string {
  return messages.map(userText).find(Boolean) ?? 'Untitled conversation';
}

/** A classified warmup answer rejects fan-out immediately while preserving its HTTP body. */
class WarmupFailure extends Error {
  constructor(readonly answer: Response) {
    super('AgentCore warmup failed');
  }
}

export function createChatService(
  cartridgeFactory: CartridgeFactory,
  config: ChatServiceConfig,
  sessionMetadata: SessionMetadata,
  agentDocuments: AgentDocuments,
  invokeSessionApi: SessionApi = sessionApi(config.sessionApi),
  scheduled: { tasks: ScheduledTasks; queue: RunQueue; draining: () => Promise<boolean>; onClose?: (stop: () => void) => void } | null = null,
): Hono {
  const scheduledTasks = scheduled?.tasks ?? null;
  const options = config.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.connectTimeoutMs };
  const runtime = config.agentCore && agentCoreUpstream(config.agentCore, options);
  const agentCore = runtime && sessionLifecycle(runtime, runtime.stop);
  const httpsHarness = config.harnessEndpoint && httpsHarnessUpstream(config.harnessEndpoint, options, config.agentCore);
  const upstream = httpsHarness ? sessionLifecycle(httpsHarness, httpsHarness.stop)
    : config.localHarnessUrl ? sessionLifecycle(localAgentUpstream(config.localHarnessUrl, options)) : agentCore;
  const runtimeNamespaceRequired = Boolean(httpsHarness) || (!config.localHarnessUrl && agentCore !== null);
  const requireRuntimeNamespace = async () => {
    if (!runtimeNamespaceRequired) return;
    try {
      await sessionMetadata.checkRuntimeNamespaceReady();
    } catch (error) {
      console.error('Session Runtime namespace readiness failed', error);
      throw new HttpError(503, 'Session Runtime namespace is not ready');
    }
  };
  const purge = purgeQueue(invokeSessionApi, (owner) => cartridge.filingUserId(owner), async (session) => {
    if (upstream === null) throw new HttpError(503, 'The Session Runtime is not configured');
    if (!trackedRuntime(session)) await sessionMetadata.assertNoDispatch(session);
    await requireRuntimeNamespace();
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
  }, undefined, (session) => sessionMetadata.completePurge(session));
  const purgeSessions = (sessions: SessionPurge[], wait = false) => {
    if (sessions.length > 0 && upstream === null) throw new HttpError(503, 'The Session Runtime is not configured');
    if (sessions.length > 0 && httpsHarness && !httpsHarness.runtimeBound) throw new HttpError(503, 'HTTPS Harness Runtime stop identity is unproved; deletion remains pending');
    upstream?.fence(sessions);
    agentCore?.fence(sessions);
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
    } finally {
      // Surviving tasks discover fences written by another task after their initial scan.
      setTimeout(() => { void recoverPurges(); }, 120_000).unref();
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
  const summarizeTurn = bedrockTurnSummarizer(config.turnSummaryModel);
  const turnIdentity = config.turnIdentity === undefined ? null : new TurnIdentity(config.turnIdentity);
  const app = new Hono();
  let scheduledRunsUnavailable = false;
  if (scheduled !== null) {
    const deps = { cartridge, sessionMetadata, agentDocuments, invokeSessionApi, scheduledTasks: scheduled.tasks, upstream, runtimeNamespaceRequired, summarizeTurn, turnIdentity };
    const stop = pollScheduledRuns(scheduled.queue, (message) => runScheduledTask(deps, message), scheduled.draining, () => {
      scheduledRunsUnavailable = true;
    }, async () => {
      for (const { owner, taskId, error } of await scheduled.tasks.retireExpired()) {
        console.error('Scheduled task retirement failed', { owner, taskId }, error);
      }
    }, () => scheduled.tasks.checkHealth());
    scheduled.onClose?.(stop);
  }

  app.use(cors(config.corsOrigins ?? cartridge.corsOrigins ?? LOCAL_UI_ORIGINS));
  app.onError((error, c) => {
    if (!(error instanceof HttpError) || error.cause !== undefined) {
      console.error(`${c.req.method} ${c.req.path} failed`, error);
    }
    if (error instanceof SessionDispatchPendingError) return c.json({ detail: error.message, status: 'pending' }, 503);
    if (error instanceof SessionNamespaceNotReadyError) return c.json({ detail: error.message }, 503);
    if (error instanceof HttpError) return c.json({ detail: error.detail, ...(error.code === undefined ? {} : { code: error.code }) }, error.status as 400);
    return c.text('Internal Server Error', 500);
  });
  if (turnIdentity !== null) app.route('/', turnIdentityRoutes(turnIdentity));
  app.route('/', cartridge.routes);

  /** What the Harness gets for a Turn on `input`, but its Session's filing ID: the Cartridge's payload with the Agent Documents. */
  const turnPayload = async (input: RunAgentInput, requester: Requester, model: AgentModel, captureCredentials?: (credentials: readonly string[]) => void) => {
    // A client must not claim an identity or credential: the Cartridge sets these props itself, or the Harness gets none.
    const forwardedProps = { ...(input.forwardedProps as Record<string, unknown>) };
    for (const prop of [...BOTCUBE_CREDENTIAL_PROPS, ...cartridge.credentialProps, ...(cartridge.identityProps ?? [])]) delete forwardedProps[prop];
    const preparing = cartridge.invocationPayload({ ...input, forwardedProps }, requester, model).then((payload) => {
      captureCredentials?.(turnCredentials(payload.forwardedProps, cartridge.credentialProps));
      return payload;
    });
    const [payload, documents] = await admissionResults([preparing, agentDocuments.get(requester.owner, cartridge.agentDocuments)]);
    // Named to the Harness, so a Turn that names no model runs on the one resolved for it, not the Harness's own default.
    payload.forwardedProps.model = model.key;
    payload.forwardedProps.agentIdentity = documents.agentIdentity;
    payload.forwardedProps.soul = documents.soul;
    return payload;
  };

  const sessionAccessError = (error: unknown): unknown => {
    if (error instanceof SessionBusyError) return new HttpError(409, 'The previous Turn is still going');
    if (error instanceof SessionClaimError) return new HttpError(409, 'Account Claim is in progress. Finish signing in and retry.');
    if (error instanceof SessionDeletedError) return new HttpError(410, 'The Session was deleted');
    return error;
  };

  app.post('/', async (c) => {
    const receipt = performance.now();
    const body = withoutOptionalNulls(await c.req.json().catch(() => undefined));
    const parsed = RunAgentInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);
    if (upstream === null) return c.json({ error: 'AGENTCORE_RUNTIME_ARN is not configured' }, 503);
    const timing = new TurnTiming(receipt, parsed.data.runId, parsed.data.threadId, c.req.header('user-agent'));
    try {
      const [, requester] = await Promise.all([requireRuntimeNamespace(), cartridge.requester(c)]);
      timing.mark('requester');
      // Forward the client's input as sent, but its held IDs: the protocol allows fields this schema does not know.
      const input = body as RunAgentInput;
      const validatedInput = parsed.data as RunAgentInput;
      const opening = input.forwardedProps?.opening === true;
      if (opening && input.messages.length !== 0) throw new HttpError(422, 'An opening Turn cannot contain messages');
      const initialMessages = structuredClone(input.messages);
      const held = takeHeldIds(input.forwardedProps ?? {});
      const model = await requireAllowedModel(input, cartridge, requester);
      timing.model = model.key;
      timing.mark('model');
      const running = { startedAt: new Date().toISOString(), runId: input.runId };
      const request = validatedInput.messages.slice().reverse().find((message) => userText(message) !== '');
      let filingUserId: string;
      try {
        filingUserId = await sessionMetadata.recordTurn(requester.owner, input.threadId, {
          filingUserId: cartridge.filingUserId(requester.owner),
          title: title(validatedInput.messages),
          provider: model.provider,
          running,
          messageId: input.runId,
          opening,
        });
      } catch (error) {
        if (error instanceof SessionOpeningError) throw new HttpError(409, error.message);
        if (error instanceof SessionProviderError) {
          throw new HttpError(
            409,
            `Model ${JSON.stringify(model.key)} is from ${model.provider}; this Session runs on ${error.provider} models`,
          );
        }
        throw sessionAccessError(error);
      }
      timing.mark('admitted');
      const end = (failure: TurnFailure | undefined) => sessionMetadata.turnEnded(requester.owner, input.threadId, running, failure);
      let credentials = turnCredentials(input.forwardedProps ?? {}, cartridge.credentialProps);
      try {
        const payload = await turnPayload(input, requester, model, (issued) => { credentials = [...credentials, ...issued]; });
        timing.mark('payload');
        const identity = await forwardTurnIdentity(turnIdentity, payload.forwardedProps, {
          actorId: cartridge.filingUserId(requester.owner), filingActorId: filingUserId, sessionId: input.threadId, startedAt: running.startedAt,
        });
        timing.mark('identity');
        if (identity !== undefined) credentials = [...credentials, identity];
        payload.forwardedProps.sessionUserId = filingUserId;
        cartridge.turnStarting?.(requester, input.threadId);
        const browserLiveView = await cartridge.browserLiveView?.(requester, input.threadId);
        timing.mark('liveView');
        const saveTurn = (finished: TurnActivity) => request === undefined ? undefined : sessionMetadata.saveTurnSummary(requester.owner, { sessionId: input.threadId, filingUserId, messageId: request.id }, finished);
        const complete = await sessionMetadata.beginDispatch(requester.owner, input.threadId, undefined, running);
        timing.mark('dispatch');
        return await relayTurn({ label: upstream.label, invoke: (body, sessionId, init) => upstream.invokeRegistered(body, complete.session ?? { session_id: sessionId, filing_user_id: filingUserId }, complete, init) }, {
          timing,
          body: JSON.stringify(payload),
          sessionId: input.threadId,
          accept: c.req.header('accept'),
          browserEventName: cartridge.browserEventName ?? BROWSER_LIVE_VIEW_EVENT,
          ...(browserLiveView ? { initialBrowserSessionId: browserLiveView.sessionId } : {}),
          saveAgentDocumentEdit: (edit) => agentDocuments.save(requester.owner, agentDocumentEdit(edit)),
          credentials,
          initialMessages,
          held,
          finished: async (answer) => {
            if (request === undefined) return;
            try {
              await recordTurnSummary(summarizeTurn, async (finished) => saveTurn(finished), input.threadId, { request: userText(request), answer });
            } catch (error) {
              // The stream has closed: the Session record takes the failure to the thread's next read.
              const failure = { code: 'TURN_SUMMARY_FAILED', message: (error as Error).message };
              await sessionMetadata.turnSummaryFailed(requester.owner, input.threadId, running, failure).catch((recordError: unknown) => {
                throw new AggregateError([error, recordError], 'The Turn summary failed and its failure could not be recorded');
              });
              throw error;
            }
          },
          failed: (message) => request === undefined ? undefined : saveTurn(turnActivity(userText(request), message)),
          ended: end,
          started: () => sessionMetadata.turnStarted(requester.owner, input.threadId, running),
        });
      } catch (error) {
        try {
          await end(preparationFailure(error, credentials));
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Turn preparation failed and its running mark could not be cleared');
        }
        throw sessionAccessError(error);
      }
    } catch (error) {
      timing.finish();
      throw error;
    }
  });

  // An explicit Stop: the only way a Turn stops before it ends, since one whose client goes away runs on.
  app.post('/threads/:id/stop', async (c) => {
    if (upstream === null) return c.json({ error: 'AGENTCORE_RUNTIME_ARN is not configured' }, 503);
    const { owner } = await cartridge.requester(c);
    const sessionId = c.req.param('id');
    const body: unknown = await c.req.json().catch(() => undefined);
    const runId = isRecord(body) ? body.runId : undefined;
    if (typeof runId !== 'string' || !runId) throw new HttpError(422, 'runId is required');
    const metadata = await sessionMetadata.get(owner, sessionId);
    if (metadata === null) throw new HttpError(404, 'Session not found');
    if (metadata.turn_preparing === true) throw new HttpError(409, 'The Turn is still preparing. Retry Stop once it starts.');
    const stop = JSON.stringify({
      threadId: sessionId,
      runId,
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { stop: true, sessionUserId: metadata.filing_user_id },
    });
    try {
      await requireRuntimeNamespace();
      const complete = await sessionMetadata.beginDispatch(owner, sessionId);
      await stopTurn({ label: upstream.label, invoke: (body, id, init) => upstream.invokeRegistered(body, complete.session ?? metadata, complete, init) }, stop, sessionId);
    } catch (error) {
      console.error(`The Turn could not be stopped session_id=${sessionId}`, error);
      throw new HttpError(502, `The Turn could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return c.body(null, 204);
  });

  app.post('/warmup', async (c) => {
    if (upstream === null) {
      return c.json({ status: 'skipped', reason: 'AGENTCORE_RUNTIME_ARN not configured' });
    }
    let request: unknown = {};
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > 0) {
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        return c.json({ error: 'Invalid warmup JSON', details: String(error) }, 400);
      }
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return c.json({ error: 'Invalid warmup JSON', details: 'Expected JSON object.' }, 400);
      }
    }
    await requireRuntimeNamespace();
    let namedSession: { owner: string; accountActorId: string; session: SessionPurge } | undefined;
    const { threadId, mainChat, model: requestedModel, effort } = request as Record<string, unknown>;
    const input: RunAgentInput = {
      threadId: WARMUP_SESSION_ID,
      runId: '__warmup__',
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { warmup: true },
    };
    let warmSession: () => Promise<void> = async () => undefined;
    if (mainChat === true || (typeof threadId === 'string' && threadId)) {
      // The requester's own Turn invocation, with no message: the Harness builds their agent for the Turn to come.
      const requester = await cartridge.requester(c);
      input.threadId = mainChat === true ? await sessionMetadata.mainChat(requester.owner, cartridge.filingUserId(requester.owner)) : (threadId as string);
      input.forwardedProps = {
        // Unnamed, the model is the one the account's model selector starts on.
        model: requestedModel ?? accountDefaultModel(await accountModelList(cartridge, requester)).key,
        ...(typeof effort === 'string' && { effort }),
      };
      const payload = await turnPayload(input, requester, await requireAllowedModel(input, cartridge, requester));
      const recorded = await sessionMetadata.get(requester.owner, input.threadId);
      input.forwardedProps = {
        ...payload.forwardedProps,
        warmup: true,
        sessionUserId: recorded?.filing_user_id ?? cartridge.filingUserId(requester.owner),
      };
      const sessionId = input.threadId;
      namedSession = { owner: requester.owner, accountActorId: cartridge.filingUserId(requester.owner), session: { session_id: sessionId, filing_user_id: input.forwardedProps.sessionUserId as string } };
      warmSession = () => cartridge.warmSession(requester, sessionId);
    }
    const warmAgent = async () => {
      try {
        const init = { signal: AbortSignal.timeout(config.warmupTimeoutMs) };
        const complete = namedSession === undefined ? Object.assign(async () => undefined, { session: undefined })
          : await sessionMetadata.beginDispatch(namedSession.owner, namedSession.session.session_id, namedSession.session.filing_user_id);
        if (complete.session !== undefined) input.forwardedProps.sessionUserId = complete.session.filing_user_id;
        if (namedSession !== undefined) {
          // The warmup reads the Session's history under its own Turn identity.
          await forwardTurnIdentity(turnIdentity, input.forwardedProps, {
            actorId: namedSession.accountActorId, filingActorId: input.forwardedProps.sessionUserId as string,
            sessionId: input.threadId, startedAt: new Date().toISOString(),
          }).catch(async (error: unknown) => {
            await complete();
            throw error;
          });
        }
        const response = await (namedSession === undefined
          ? upstream.invoke(JSON.stringify(input), input.threadId, init)
          : upstream.invokeRegistered(JSON.stringify(input), complete.session ?? namedSession.session, complete, init));
        if (response.status >= 400) {
          await response.body?.cancel();
          return c.json({ error: 'AgentCore warmup failed', details: `HTTP ${response.status}` }, 502);
        }
        const credentials = turnCredentials(input.forwardedProps as Record<string, unknown>, cartridge.credentialProps);
        const failure = runError(await response.text(), credentials);
        if (failure !== null) {
          return c.json({ error: 'AgentCore warmup failed', details: turnErrorDetails(failure, credentials) }, 502);
        }
      } catch (error) {
        console.warn('warmup failed', error);
        return c.json({ error: 'AgentCore warmup failed', details: String(error) }, 502);
      }
      return c.json({ status: 'ok' });
    };
    // The Cartridge readies its own side of the chat, such as its browser, while the agent builds; its failure answers.
    const agent = warmAgent().then((answer) => {
      if (!answer.ok) throw new WarmupFailure(answer);
      return answer;
    });
    try {
      const [answer] = await Promise.all([agent, warmSession()]);
      return answer;
    } catch (error) {
      if (error instanceof WarmupFailure) return error.answer;
      throw error;
    }
  });

  app.get('/health', async (c) => {
    await initialRecovery;
    try {
      await sessionMetadata.checkHealth();
    } catch (error) {
      console.error('Session Metadata readiness probe failed', error);
      throw new HttpError(503, 'Session Metadata storage is unavailable');
    }
    if (scheduledRunsUnavailable) throw new HttpError(503, 'Scheduled runs are unavailable');
    await scheduledTasks?.checkHealth();
    await requireRuntimeNamespace();
    if (recoveryError !== undefined) throw new HttpError(503, 'Session purge recovery is unavailable');
    return c.json({ status: 'ok' });
  });

  const documentsOf = async (owner: string) => agentDocuments.get(owner, cartridge.agentDocuments);

  // The Agent Profile: the account's agent, and whether a Harness is there to answer it.
  app.get('/agent', async (c) => {
    const { owner } = await cartridge.requester(c);
    const [{ agentIdentity: identity }, agentPicture] = await Promise.all([documentsOf(owner), agentDocuments.picture(owner)]);
    return c.json({
      name: identity.name,
      avatar: identity.avatar,
      picture: agentPicture && pictureUrl(agentPicture),
      status: upstream === null ? 'offline' : 'online',
    });
  });

  // The agent's picture: kept apart from Agent Identity, which every Turn carries.
  app.put('/agent/picture', async (c) => {
    const { owner } = await cartridge.requester(c);
    const body = (await c.req.json().catch(() => undefined)) as { picture?: unknown } | undefined;
    await agentDocuments.savePicture(owner, picture(body?.picture, "The agent's picture"));
    return c.body(null, 204);
  });

  app.delete('/agent/picture', async (c) => {
    await agentDocuments.savePicture((await cartridge.requester(c)).owner, null);
    return c.body(null, 204);
  });

  // The models the account may run its Turns on, which the UI's model selector offers.
  app.get('/agent/models', async (c) => {
    const requester = await cartridge.requester(c);
    try {
      return c.json({ models: await accountModelList(cartridge, requester, { refresh: true }) });
    } catch (error) {
      // A failed account catalog remains a failure; these are independently available explicit choices.
      if (error instanceof HttpError && (error.status === 502 || error.status === 503)) {
        return c.json({ detail: error.detail, cartridgeModels: cartridge.models }, error.status);
      }
      throw error;
    }
  });

  app.get('/agent/identity', async (c) => c.json((await documentsOf((await cartridge.requester(c)).owner)).agentIdentity));

  app.put('/agent/identity', async (c) => {
    const { owner } = await cartridge.requester(c);
    const content = agentIdentity(await c.req.json().catch(() => undefined));
    await agentDocuments.save(owner, { document: 'agentIdentity', content });
    return c.body(null, 204);
  });

  app.get('/agent/soul', async (c) => c.json({ content: (await documentsOf((await cartridge.requester(c)).owner)).soul }));

  app.put('/agent/soul', async (c) => {
    const { owner } = await cartridge.requester(c);
    const body = (await c.req.json().catch(() => undefined)) as { content?: unknown } | undefined;
    await agentDocuments.save(owner, { document: 'soul', content: soul(body?.content) });
    return c.body(null, 204);
  });

  // Memory: one document, a line per AgentCore Memory record, read and edited through the session API.
  app.get('/agent/memory', async (c) => {
    const { owner } = await cartridge.requester(c);
    const { lines } = await invokeSessionApi({ operation: 'memory', userId: cartridge.filingUserId(owner) });
    return c.json({ lines });
  });

  app.put('/agent/memory/:id', async (c) => {
    const { owner } = await cartridge.requester(c);
    const text = memoryLine(await c.req.json().catch(() => undefined));
    const recordId = c.req.param('id');
    await invokeSessionApi({ operation: 'memory-edit', userId: cartridge.filingUserId(owner), recordId, text });
    return c.body(null, 204);
  });

  app.delete('/agent/memory/:id', async (c) => {
    const { owner } = await cartridge.requester(c);
    const recordId = c.req.param('id');
    await invokeSessionApi({ operation: 'memory-delete', userId: cartridge.filingUserId(owner), recordId });
    return c.body(null, 204);
  });

  app.get('/ping', (c) => {
    if (scheduledRunsUnavailable) throw new HttpError(503, 'Scheduled runs are unavailable');
    return c.json({ status: 'Healthy' });
  });

  // The Side Chats: every Session but the Main Chat.
  app.get('/threads', async (c) => {
    const { owner } = await cartridge.requester(c);
    return c.json({ threads: await sessions.sideChats(owner) });
  });

  // The Session the user lands in, replayed once it has Turns.
  app.get('/main-chat', async (c) => {
    const { owner } = await cartridge.requester(c);
    return c.json(await sessions.mainChat(owner));
  });

  // The Agent Profile's Activity: every Session's answered Turns, most recently finished first,
  // each with its stored summary, or the first line of its request when it has none.
  app.get('/activity', async (c) => {
    const { owner } = await cartridge.requester(c);
    return c.json({ tasks: await sessions.activity(owner) });
  });

  // Scheduled tasks: created from the agent's proposal once the user confirms it.
  const tasks = (): ScheduledTasks => {
    if (scheduledTasks === null) throw new HttpError(503, 'Scheduled tasks are not configured');
    return scheduledTasks;
  };

  /** The task as its sheet shows it: with whether its Side Chat, named by the task's ID once it has run there, exists. */
  const taskView = async (owner: string, task: ScheduledTask) => ({ ...task, sideChat: (await sessionMetadata.get(owner, task.id)) !== null });

  app.get('/scheduled-tasks', async (c) => {
    const { owner } = await cartridge.requester(c);
    return c.json({ tasks: await Promise.all((await tasks().list(owner)).map((task) => taskView(owner, task))) });
  });

  app.post('/scheduled-tasks', async (c) => {
    const requester = await cartridge.requester(c);
    const { owner } = requester;
    const scheduled = tasks();
    const body: unknown = await c.req.json().catch(() => undefined);
    const definition = taskDefinition(body, true) as ScheduledTaskDefinition;
    const model = isRecord(body) ? body.model : undefined;
    if (model !== undefined) definition.model = (await namedModel(cartridge, requester, model)).key;
    // The proposal's tool call: a second confirmation of it answers the task the first made.
    const proposalId = (body as Record<string, unknown>).proposalId;
    if (typeof proposalId !== 'string' || !proposalId.trim()) throw new HttpError(422, 'proposalId is required');
    const { task, created } = await scheduled.create(owner, proposalId, definition);
    return c.json(await taskView(owner, task), created ? 201 : 200);
  });

  app.patch('/scheduled-tasks/:id', async (c) => {
    const requester = await cartridge.requester(c);
    const { owner } = requester;
    const body: unknown = await c.req.json().catch(() => undefined);
    const changes = taskDefinition(body, false);
    const paused = isRecord(body) ? body.paused : undefined;
    if (paused !== undefined && typeof paused !== 'boolean') throw new HttpError(422, 'paused must be true or false');
    // A task that names no model runs on the account's default; a model it names must be one its runs may use.
    const model = isRecord(body) ? body.model : undefined;
    if (model !== undefined) changes.model = (await namedModel(cartridge, requester, model)).key;
    const updated = await tasks().update(owner, c.req.param('id'), paused === undefined ? changes : { ...changes, paused });
    if (updated === null) throw new HttpError(404, 'Scheduled task not found');
    return c.json(await taskView(owner, updated));
  });

  app.delete('/scheduled-tasks/:id', async (c) => {
    const { owner } = await cartridge.requester(c);
    if (!(await tasks().delete(owner, c.req.param('id')))) throw new HttpError(404, 'Scheduled task not found');
    return c.body(null, 204);
  });

  // Replay one Session from its record, after checking ownership in Session Metadata.
  app.get('/threads/:id', async (c) => {
    const { owner } = await cartridge.requester(c);
    const sessionId = c.req.param('id');
    return c.json(await sessions.replay(owner, sessionId));
  });

  app.patch('/threads/:id', async (c) => {
    const { owner } = await cartridge.requester(c);
    const body: unknown = await c.req.json().catch(() => undefined);
    const title = isRecord(body) ? body.title : undefined;
    if (typeof title !== 'string' || !title.trim()) throw new HttpError(422, 'title must be a non-empty string');
    return c.json(await sessions.renameSideChat(owner, c.req.param('id'), title).catch((error: unknown) => { throw sessionAccessError(error); }));
  });

  // Fence the Session at once, then purge its events in the background (ADR 0067 §6).
  app.delete('/threads/:id', async (c) => {
    const { owner } = await cartridge.requester(c);
    const sessionId = c.req.param('id');
    await sessions.removeSideChat(owner, sessionId);
    return c.body(null, 204);
  });

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

/** Serve the Chat Service with this Cartridge, configured from the environment, on $PORT. */
export function serveChatService(cartridge: CartridgeFactory, env: NodeJS.ProcessEnv = process.env): ServerType {
  const config = configFromEnv(env);
  if (config.agentCore === null && config.localHarnessUrl === null && !config.harnessEndpoint) {
    console.warn('AGENTCORE_RUNTIME_ARN is not set; agent runs (POST /) return 503 and warmup is skipped until it is configured.');
  }
  const table = chatTable(env);
  const scheduler = schedulerConfigFromEnv(env);
  let stopScheduledRuns: (() => void) | undefined;
  let built: ChatServiceCartridge | undefined;
  const app = createChatService(
    (history) => (built = cartridge(history)),
    config,
    new DynamoDBSessionMetadata(table),
    new DynamoDBAgentDocuments(table),
    sessionApi(config.sessionApi),
    scheduler && {
      tasks: new ScheduledTasks(table, scheduler),
      queue: sqsRunQueue(scheduler.queueUrl),
      draining: ecsTaskDraining(env.ECS_CONTAINER_METADATA_URI_V4),
      onClose: (stop) => { stopScheduledRuns = stop; },
    },
  );
  const port = Number(env.PORT || 8123);
  // WebSocket routes a Cartridge declares with `upgradeWebSocket` upgrade here.
  // ws types `noServer` as `boolean | undefined`, which exactOptionalPropertyTypes keeps from matching.
  const websocket = { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike };
  const server = serve({ fetch: app.fetch, port, hostname: env.BOTCUBE_CHAT_HOST || '0.0.0.0', websocket }, () =>
    console.log(`Chat Service listening on :${port}`),
  );
  const sleepAgentComputers = built?.sleepAgentComputers?.bind(built);
  const unregisterTaskStop = sleepAgentComputers && sleepComputersAtTaskStop(sleepAgentComputers);
  // A Turn's summary runs on after its stream closed: a task stopped meanwhile alarms on it.
  process.on('exit', reportUnsavedTurnSummaries);
  server.once('close', () => {
    unregisterTaskStop?.();
    stopScheduledRuns?.();
    process.off('exit', reportUnsavedTurnSummaries);
  });
  return server;
}

async function admissionResults<const T extends readonly Promise<unknown>[]>(tasks: T) {
  try {
    return await Promise.all(tasks);
  } catch (error) {
    void Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected' && result.reason !== error) console.error('Concurrent Turn preparation failed', result.reason);
      }
    });
    throw error;
  }
}
