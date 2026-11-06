import type { Hono } from 'hono';
import type { RunAgentInput } from '@ag-ui/client';
import { RunAgentInputSchema, RunErrorEventSchema } from '@ag-ui/core/schemas';
import { agentDocumentEdit, type AgentDocuments } from './agent-documents.js';
import { HttpError, type ChatServiceCartridge, type Requester, type AgentModel } from './cartridge.js';
import { warmingSessions, warmupTiming } from './warming-sessions.js';
import { accountDefaultModel, accountModelList, requireAllowedModel } from './models.js';
import { SessionOpeningError, SessionProviderError, SessionUnissuedError, type SessionMetadata, type PreparedTurn, type TurnFailure, type TurnActivity, type SessionPurge } from './session-metadata.js';
import { assertIdleContinuable, sessionAccessError } from './sessions.js';
import { SessionReadOnlyError } from './session-identity.js';
import { forwardSnapshotEpoch, type sessionLifecycle } from './session-lifecycle.js';
import { forwardTurnIdentity, type TurnIdentity } from './turn-identity.js';
import { TurnTiming } from './turn-timing.js';
import type { TurnQuota } from './turn-quota.js';
import { persistedTurnError, turnErrorDetails, turnCredentials, relayTurn, stopTurn, type HeldIds } from './turn-stream.js';
import { recordTurnSummary, turnActivity, type bedrockTurnSummarizer } from './turn-summaries.js';
import { readTurnEvents } from './turn-events.js';
import { steeringRoutes } from './steering-routes.js';

const WARMUP_SESSION_ID = '__warmup__000000000000000000000000';
const BOTCUBE_CREDENTIAL_PROPS = ['temporary', 'agentComputerCdpUrl', 'credentialServiceInvocationToken', 'credentialServiceUrl', 'files'];

function preparationFailure(error: unknown, credentials: readonly string[]): TurnFailure {
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'TURN_PREPARATION_FAILED', message: persistedTurnError(turnErrorDetails(message, credentials)) };
}

async function runError(stream: string, credentials: readonly string[]): Promise<string | null> {
  const events = await readTurnEvents(stream, credentials);
  if (events === null) return "The error body carried the Turn's credentials, so it was withheld";
  const error = events.find((event) => event.type === 'RUN_ERROR');
  return error === undefined ? null : RunErrorEventSchema.parse(error).message;
}

const isRecord =(value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dropNulls = (value: unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) : value;

function omitOptionalNulls(body: unknown): unknown {
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


function takeHeldIds(forwardedProps: Record<string, unknown>): HeldIds {
  const ids = (prop: 'heldMessageIds' | 'heldToolCallIds'): string[] => {
    const value = forwardedProps[prop] ?? [];
    delete forwardedProps[prop];
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id !== '')) throw new HttpError(422, `${prop} must be a list of IDs`);
    return value;
  };
  return { messageIds: ids('heldMessageIds'), toolCallIds: ids('heldToolCallIds') };
}

type Message = RunAgentInput['messages'][number];

function userText(message: Message): string {
  if (message.role !== 'user') return '';
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
  return text.trim();
}

/** The error grouper's traffic marker: the client's, else `test` for a `-Verification/` deploy check. */
function trafficMarker(sent: unknown, userAgent: string | undefined): { traffic?: 'test' | 'real' } {
  if (sent === 'test' || sent === 'real') return { traffic: sent };
  if (sent !== undefined) throw new HttpError(422, 'traffic must be "test" or "real"');
  return userAgent?.includes('-Verification/') ? { traffic: 'test' } : {};
}

class WarmupFailure extends Error {
  constructor(readonly answer: Response) {
    super('AgentCore warmup failed');
  }
}

export function turnRoutes(
  app: Hono,
  cartridge: ChatServiceCartridge,
  sessionMetadata: SessionMetadata,
  agentDocuments: AgentDocuments,
  upstream: ReturnType<typeof sessionLifecycle> | null,
  config: { warmupTimeoutMs: number },
  summarizeTurn: ReturnType<typeof bedrockTurnSummarizer>,
  turnIdentity: TurnIdentity | null,
  turnQuota: TurnQuota | null,
) {
  const warming = warmingSessions();

  const requireCandidatePrompts = (forwardedProps: Record<string, unknown> | undefined, requester: Requester) => {
    for (const prop of ['agentSystemPrompt', 'cartridgeSystemPrompt']) {
      const candidate = forwardedProps?.[prop];
      if (candidate === undefined) continue;
      if (cartridge.tunesPrompts?.(requester) !== true) throw new HttpError(403, `${prop} is only for the prompt tuner`);
      if (typeof candidate !== 'string') throw new HttpError(422, `${prop} must be text`);
    }
  };

  const turnPayload = async (input: RunAgentInput, requester: Requester, model: AgentModel, captureCredentials?: (credentials: readonly string[]) => void) => {
    const forwardedProps = { ...(input.forwardedProps as Record<string, unknown>) };
    for (const prop of [...BOTCUBE_CREDENTIAL_PROPS, ...cartridge.credentialProps, ...(cartridge.identityProps ?? [])]) delete forwardedProps[prop];
    const preparing = cartridge.invocationPayload({ ...input, forwardedProps }, requester, model).then((payload) => {
      captureCredentials?.(turnCredentials(payload.forwardedProps, cartridge.credentialProps));
      return payload;
    });
    const [payload, documents] = await admissionResults([preparing, agentDocuments.get(requester.owner, cartridge.agentDocuments)]);
    payload.forwardedProps.model = model.key;
    payload.forwardedProps.agentIdentity = documents.agentIdentity;
    payload.forwardedProps.soul = documents.soul;
    return payload;
  };

  app.post('/', async (c) => {
    const receipt = performance.now();
    const body = omitOptionalNulls(await c.req.json().catch(() => undefined));
    const parsed = RunAgentInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);
    if (upstream === null) return c.json({ error: 'AGENTCORE_RUNTIME_ARN is not configured' }, 503);
    const timing = new TurnTiming(receipt, parsed.data.runId, parsed.data.threadId, c.req.header('user-agent'));
    try {
      const requester = await cartridge.requester(c);
      timing.mark('requester');
      // Forward the client's input as sent, but its held IDs: the protocol allows fields this schema does not know.
      const input = body as RunAgentInput;
      const validatedInput = parsed.data as RunAgentInput;
      const opening = input.forwardedProps?.opening === true;
      if (opening && input.messages.length !== 0) throw new HttpError(422, 'An opening Turn cannot contain messages');
      const initialMessages = structuredClone(input.messages);
      const held = takeHeldIds(input.forwardedProps ?? {});
      const model = await requireAllowedModel(input, cartridge, requester);
      requireCandidatePrompts(input.forwardedProps, requester);
      const traffic = trafficMarker(input.forwardedProps?.traffic, c.req.header('user-agent'));
      timing.model = model.key;
      timing.mark('model');
      await turnQuota?.admit(requester.owner, c.req.header('cf-connecting-ip'), requester.rateTier === 'authenticated');
      const running = { startedAt: new Date().toISOString(), runId: input.runId };
      const request = validatedInput.messages.slice().reverse().find((message) => message.role === 'user');
      let prepared: PreparedTurn;
      let filingUserId: string;
      try {
        prepared = await sessionMetadata.prepareTurn(requester.owner, input.threadId, {
          filingUserId: cartridge.filingUserId(requester.owner),
          title: (validatedInput.messages.map(userText).find(Boolean) ?? 'Untitled conversation').slice(0, 200),
          provider: model.provider,
          running,
          messageId: input.runId,
          opening,
        });
        filingUserId = prepared.session.filing_user_id;
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
        Object.assign(payload.forwardedProps, traffic);
        payload.forwardedProps.turnStartedAt = running.startedAt;
        cartridge.turnStarting?.(requester, input.threadId);
        const browserLiveView = await cartridge.browserLiveView?.(requester, input.threadId);
        timing.mark('liveView');
        const saveTurn = (finished: TurnActivity) => request === undefined ? undefined : sessionMetadata.saveTurnSummary(requester.owner, { sessionId: input.threadId, filingUserId, messageId: request.id }, finished);
        await warming.until(requester.owner, input.threadId, config.warmupTimeoutMs);
        const complete = await prepared.dispatch();
        forwardSnapshotEpoch(payload.forwardedProps, complete);
        timing.mark('dispatch');
        return await relayTurn({ label: upstream.label, invoke: (body, _sessionId, init) => upstream.invokeRegistered(body, complete.session, complete, init) }, {
          timing,
          body: JSON.stringify(payload),
          sessionId: input.threadId,
          accept: c.req.header('accept'),
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
          client: c.req.raw.signal,
          active: () => sessionMetadata.turnActive?.(requester.owner, input.threadId, running),
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

  steeringRoutes(app, cartridge, sessionMetadata, upstream);

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
    assertIdleContinuable(metadata);
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
      const complete = await sessionMetadata.beginDispatch(owner, sessionId);
      await stopTurn({ label: upstream.label, invoke: (body, id, init) => upstream.invokeRegistered(body, complete.session ?? metadata, complete, init) }, stop, sessionId);
    } catch (error) {
      console.error(`The Turn could not be stopped session_id=${sessionId}`, error);
      throw new HttpError(502, `The Turn could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return c.body(null, 204);
  });

  const namedWarmupProps = async (input: RunAgentInput, requester: Requester, requestedModel: unknown, effort: unknown) => {
    input.forwardedProps = {
      model: requestedModel ?? accountDefaultModel(await accountModelList(cartridge, requester)).key,
      ...(typeof effort === 'string' && { effort }),
    };
    const payload = await turnPayload(input, requester, await requireAllowedModel(input, cartridge, requester));
    const recorded = await sessionMetadata.get(requester.owner, input.threadId);
    return { ...payload.forwardedProps, warmup: true, sessionUserId: recorded?.filing_user_id ?? cartridge.filingUserId(requester.owner) };
  };

  app.post('/warmup', async (c) => {
    const { mark, log } = warmupTiming();
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
    let endWarming = () => {};
    if (mainChat === true || (typeof threadId === 'string' && threadId)) {
      const requester = await cartridge.requester(c);
      input.threadId = mainChat === true ? await sessionMetadata.mainChat(requester.owner, cartridge.filingUserId(requester.owner)) : (threadId as string);
      endWarming = warming.begin(requester.owner, input.threadId);
      input.forwardedProps = await namedWarmupProps(input, requester, requestedModel, effort).catch((error: unknown) => {
        endWarming();
        throw error;
      });
      mark('props');
      const sessionId = input.threadId;
      namedSession = { owner: requester.owner, accountActorId: cartridge.filingUserId(requester.owner), session: { session_id: sessionId, filing_user_id: input.forwardedProps.sessionUserId as string } };
      warmSession = () => cartridge.warmSession(requester, sessionId);
    }
    const warmAgent = async () => {
      try {
        const init = { signal: AbortSignal.timeout(config.warmupTimeoutMs) };
        const complete = namedSession === undefined ? Object.assign(async () => undefined, { session: undefined, snapshotEpoch: undefined })
          : await sessionMetadata.beginDispatch(namedSession.owner, namedSession.session.session_id, namedSession.session.filing_user_id);
        mark('dispatch');
        if (complete.session !== undefined) input.forwardedProps.sessionUserId = complete.session.filing_user_id;
        if (namedSession !== undefined) {
          await forwardTurnIdentity(turnIdentity, input.forwardedProps, {
            actorId: namedSession.accountActorId, filingActorId: input.forwardedProps.sessionUserId as string,
            sessionId: input.threadId, startedAt: new Date().toISOString(),
          }).catch(async (error: unknown) => {
            await complete();
            throw error;
          });
          mark('identity');
        }
        forwardSnapshotEpoch(input.forwardedProps, complete);
        const response = await (namedSession === undefined
          ? upstream.invoke(JSON.stringify(input), input.threadId, init)
          : upstream.invokeRegistered(JSON.stringify(input), complete.session ?? namedSession.session, complete, init));
        mark('invoke');
        if (response.status >= 400) {
          await response.body?.cancel();
          return c.json({ error: 'AgentCore warmup failed', details: `HTTP ${response.status}` }, 502);
        }
        const credentials = turnCredentials(input.forwardedProps as Record<string, unknown>, cartridge.credentialProps);
        const text = await response.text();
        mark('answer');
        const failure = await runError(text, credentials);
        if (failure !== null) {
          return c.json({ error: 'AgentCore warmup failed', details: turnErrorDetails(failure, credentials) }, 502);
        }
      } catch (error) {
        if (error instanceof SessionUnissuedError || error instanceof SessionReadOnlyError) throw sessionAccessError(error);
        console.warn('warmup failed', error);
        return c.json({ error: 'AgentCore warmup failed', details: String(error) }, 502);
      }
      return c.json({ status: 'ok' });
    };
    const agent = warmAgent().then((answer) => {
      if (!answer.ok) throw new WarmupFailure(answer);
      return answer;
    });
    void agent.then(endWarming, endWarming);
    const session = warmSession().then(() => mark('session'));
    let outcome = 'failed';
    try {
      const [answer] = await Promise.all([agent, session]);
      outcome = 'ok';
      return answer;
    } catch (error) {
      if (error instanceof WarmupFailure) return error.answer;
      throw error;
    } finally {
      log(input.threadId, outcome);
    }
  });

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
