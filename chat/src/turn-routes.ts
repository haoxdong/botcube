import { runRuntimeWriter } from './session-writer-runtime.js';
import type { Hono } from 'hono';
import type { RunAgentInput } from '@ag-ui/client';
import { RunAgentInputSchema, RunErrorEventSchema } from '@ag-ui/core/schemas';
import { agentDocumentEdit, type AgentDocumentSet, type AgentDocuments } from './agent-documents.js';
import { memoryGates, type TurnRouteSource } from './turn-preparation.js';
import type { AgentModel } from './models.js';
import { HttpError } from './http-error.js';
import { DEPLOY_CHECK_USER_AGENT } from './production-activity.js';
import { requireCandidatePrompts } from './candidate-prompt.js';
import type { Requester } from './requester.js';
import { warmingSessions, warmupTiming } from './warming-sessions.js';
import { namedModel } from './models.js';
import { SessionDeletedError, SessionOpeningError, SessionUnissuedError, type SessionMetadata, type PreparedTurn, type TurnFailure, type TurnActivity, type SessionPurge } from './session-metadata.js';
import { assertIdleContinuable } from './sessions.js';
import { SessionReadOnlyError } from './session-identity.js';
import { forwardSnapshotEpoch, type sessionLifecycle } from './session-lifecycle.js';
import { forwardTurnIdentity, type TurnIdentitySource } from './turn-identity.js';
import { forwardUserToken, type UserTokenSigner } from './user-token.js';
import { TurnTiming } from './turn-timing.js';
import type { TurnQuota } from './turn-quota.js';
import { turnErrorDetails, credentialValues, relayTurn, stopTurn, type HeldIds } from './turn-stream.js';
import { turnActivity } from './turn-summaries.js';
import { readTurnEvents } from './turn-events.js';
import { steeringRoutes } from './steering-routes.js';
import { isRecord, omitOptionalNulls } from './payload.js';
import { preparationFailure } from './turn-preparation.js';


const WARMUP_SESSION_ID = '__warmup__000000000000000000000000';
const BOTCUBE_CREDENTIAL_PROPS = ['temporary', 'agentComputerCdpUrl', 'credentialServiceInvocationToken', 'credentialServiceUrl', 'files', 'userToken'];

async function runError(stream: string, credentials: readonly string[]): Promise<string | null> {
  const events = await readTurnEvents(stream, credentials);
  if (events === null) return "The error body carried the Turn's credentials, so it was withheld";
  const error = events.find((event) => event.type === 'RUN_ERROR');
  return error === undefined ? null : RunErrorEventSchema.parse(error).message;
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

/** The error grouper's traffic marker: the client's, else `test` for a deploy check. */
function trafficMarker(sent: unknown, userAgent: string | undefined): { traffic?: 'test' | 'real' } {
  if (sent === 'test' || sent === 'real') return { traffic: sent };
  if (sent !== undefined) throw new HttpError(422, 'traffic must be "test" or "real"');
  return userAgent?.includes(DEPLOY_CHECK_USER_AGENT) ? { traffic: 'test' } : {};
}

class WarmupFailure extends Error {
  constructor(readonly answer: Response) {
    super('AgentCore warmup failed');
  }
}

interface TurnRoutesOptions {
  bot: TurnRouteSource;
  stores: { sessionMetadata: SessionMetadata; agentDocuments: AgentDocuments };
  harness: { upstream: ReturnType<typeof sessionLifecycle> | null; warmupTimeoutMs: number };
  turns: {
    turnQuota: TurnQuota | null;
    awsAccess: TurnIdentitySource | null;
    userTokens: UserTokenSigner | null;
  };
}

export function turnRoutes(app: Hono, { bot, stores, harness, turns }: TurnRoutesOptions) {
  const { sessionMetadata, agentDocuments } = stores;
  const { upstream, warmupTimeoutMs } = harness;
  const { turnQuota, awsAccess: credentialSource, userTokens } = turns;
  const warming = warmingSessions();

  const turnPayload = async (input: RunAgentInput, requester: Requester, model: AgentModel, captureCredentials?: (credentials: readonly string[]) => void, documents: Promise<AgentDocumentSet> = agentDocuments.get(requester.owner, bot.agentDocuments)) => {
    const forwardedProps = { ...(input.forwardedProps as Record<string, unknown>) };
    for (const prop of [...BOTCUBE_CREDENTIAL_PROPS, ...bot.credentialProps, ...(bot.identityProps ?? [])]) delete forwardedProps[prop];
    const preparing = bot.invocationPayload({ ...input, forwardedProps }, requester, model).then((payload) => {
      captureCredentials?.(credentialValues(payload.forwardedProps, bot.credentialProps, payload.credentialServiceInvocationToken));
      return payload;
    });
    const [payload, loadedDocuments] = await admissionResults([preparing, documents]);
    payload.forwardedProps.model = model.key;
    payload.forwardedProps.agentIdentity = loadedDocuments.agentIdentity;
    payload.forwardedProps.soul = loadedDocuments.soul;
    memoryGates(payload.forwardedProps, bot, requester);
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
      const requester = await bot.requester(c);
      timing.mark('requester');
      // Forward the client's input as sent, but its held IDs: the protocol allows fields this schema does not know.
      const input = body as RunAgentInput;
      const validatedInput = parsed.data as RunAgentInput;
      const opening = input.forwardedProps?.opening === true;
      if (opening && input.messages.length !== 0) throw new HttpError(422, 'An opening Turn cannot contain messages');
      const initialMessages = structuredClone(input.messages);
      const held = takeHeldIds(input.forwardedProps ?? {});
      const model = await namedModel(bot, requester, input.forwardedProps?.model);
      requireCandidatePrompts(input.forwardedProps, requester, bot);
      const traffic = trafficMarker(input.forwardedProps?.traffic, c.req.header('user-agent'));
      timing.model = model.key;
      timing.mark('model');
      await turnQuota?.admit(requester.owner, c.req.header('cf-connecting-ip'), requester.rateTier === 'authenticated');
      const documents = Promise.allSettled([agentDocuments.get(requester.owner, bot.agentDocuments)]);
      const running = { startedAt: new Date().toISOString(), runId: input.runId };
      const request = validatedInput.messages.slice().reverse().find((message) => message.role === 'user');
      let prepared: PreparedTurn;
      let filingUserId: string;
      try {
        prepared = await sessionMetadata.prepareTurn(requester.owner, input.threadId, {
          filingUserId: bot.filingUserId(requester.owner),
          title: (validatedInput.messages.map(userText).find(Boolean) ?? 'Untitled conversation').slice(0, 200),
          running,
          messageId: input.runId,
          opening,
        });
        filingUserId = prepared.session.filing_user_id;
      } catch (error) {
        void documents.then(([result]) => {
          if (result.status === 'rejected' && result.reason !== error) console.error('Concurrent Turn preparation failed', result.reason);
        });
        if (error instanceof SessionOpeningError) throw new HttpError(409, error.message);
        throw error;
      }
      timing.mark('admitted');
      const end = (failure: TurnFailure | undefined) => sessionMetadata.turnEnded(requester.owner, input.threadId, running, failure);
      let credentials = credentialValues(input.forwardedProps ?? {}, bot.credentialProps);
      try {
        const { credentialServiceInvocationToken, ...payload } = await turnPayload(input, requester, model, (issued) => { credentials = [...credentials, ...issued]; }, documents.then(([result]) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value;
        }));
        timing.mark('payload');
        const identity = await forwardTurnIdentity(credentialSource, payload.forwardedProps, {
          actorId: bot.filingUserId(requester.owner), filingActorId: filingUserId, sessionId: input.threadId, startedAt: running.startedAt,
        });
        const userToken = await forwardUserToken(userTokens, payload.forwardedProps, { ...requester, threadId: input.threadId, startedAt: running.startedAt });
        timing.mark('identity');
        credentials = [...credentials, ...identity, ...userToken];
        payload.forwardedProps.sessionUserId = filingUserId;
        Object.assign(payload.forwardedProps, traffic);
        payload.forwardedProps.turnStartedAt = running.startedAt;
        bot.turnStarting?.(requester, input.threadId);
        const browserLiveView = await bot.browserLiveView?.(requester, input.threadId);
        timing.mark('liveView');
        const saveTurn = (finished: TurnActivity) => request === undefined ? undefined : sessionMetadata.saveTurnSummary(requester.owner, { sessionId: input.threadId, filingUserId, messageId: request.id }, finished);
        timing.mark('warmupWaitStart');
        try {
          await warming.until(requester.owner, input.threadId, warmupTimeoutMs);
        } finally {
          timing.mark('warmupWaitEnd');
        }
        return await runRuntimeWriter(prepared.dispatch, {
          timeoutMs: 60_000, signal: c.req.raw.signal, context: { session_id: input.threadId, run_id: input.runId },
        }, upstream, prepared.session, async (writer) => {
          forwardSnapshotEpoch(payload.forwardedProps, writer);
          timing.mark('dispatch');
          return relayTurn({ label: upstream.label, invoke: (body, id, init) => writer.invoke(body, id, { ...init, credentialServiceInvocationToken }) }, {
            timing,
            body: JSON.stringify(payload),
            sessionId: input.threadId,
            accept: c.req.header('accept'),
            ...(browserLiveView ? { initialBrowserSessionId: browserLiveView.sessionId } : {}),
            saveAgentDocumentEdit: (edit) => agentDocuments.save(requester.owner, agentDocumentEdit(edit)),
            credentials,
            initialMessages,
            held,
            finished: async () => {
              if (request === undefined) return;
              try {
                await saveTurn(turnActivity(userText(request)));
              } catch (error) {
                if (!(error instanceof SessionDeletedError)) throw error;
              }
            },
            failed: (message) => request === undefined ? undefined : saveTurn(turnActivity(userText(request), message)),
            ended: end,
            started: () => sessionMetadata.turnStarted(requester.owner, input.threadId, running, model.provider),
            client: c.req.raw.signal,
            active: () => sessionMetadata.turnActive?.(requester.owner, input.threadId, running),
          });
        });
      } catch (error) {
        try {
          await end(preparationFailure(error, credentials));
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Turn preparation failed and its running mark could not be cleared');
        }
        throw error;
      }
    } catch (error) {
      timing.finish();
      throw error;
    }
  });

  steeringRoutes(app, bot, sessionMetadata, upstream);

  app.post('/threads/:id/stop', async (c) => {
    if (upstream === null) return c.json({ error: 'AGENTCORE_RUNTIME_ARN is not configured' }, 503);
    const { owner } = await bot.requester(c);
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
      await runRuntimeWriter(() => sessionMetadata.beginDispatch(owner, sessionId), { timeoutMs: 0 }, upstream, metadata,
        ({ invoke }) => stopTurn({ label: upstream.label, invoke }, stop, sessionId));
    } catch (error) {
      console.error(`The Turn could not be stopped session_id=${sessionId}`, error);
      throw new HttpError(502, `The Turn could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return c.body(null, 204);
  });

  const namedWarmupProps = async (input: RunAgentInput, requester: Requester, requestedModel: unknown, effort: unknown) => {
    input.forwardedProps = {
      ...(typeof effort === 'string' && { effort }),
    };
    const payload = await turnPayload(input, requester, await namedModel(bot, requester, requestedModel ?? undefined));
    const recorded = await sessionMetadata.get(requester.owner, input.threadId);
    return {
      credentialServiceInvocationToken: payload.credentialServiceInvocationToken,
      forwardedProps: { ...payload.forwardedProps, warmup: true, sessionUserId: recorded?.filing_user_id ?? bot.filingUserId(requester.owner) },
    };
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
    let credentialServiceInvocationToken: string | undefined;
    let warmSession: () => Promise<void> = async () => undefined;
    let endWarming = () => {};
    if (mainChat === true || (typeof threadId === 'string' && threadId)) {
      const requester = await bot.requester(c);
      input.threadId = mainChat === true ? await sessionMetadata.mainChat(requester.owner, bot.filingUserId(requester.owner)) : (threadId as string);
      endWarming = warming.begin(requester.owner, input.threadId);
      const prepared = await namedWarmupProps(input, requester, requestedModel, effort).catch((error: unknown) => {
        endWarming();
        throw error;
      });
      input.forwardedProps = prepared.forwardedProps;
      credentialServiceInvocationToken = prepared.credentialServiceInvocationToken;
      mark('props');
      const sessionId = input.threadId;
      namedSession = { owner: requester.owner, accountActorId: bot.filingUserId(requester.owner), session: { session_id: sessionId, filing_user_id: input.forwardedProps.sessionUserId as string } };
      warmSession = () => bot.warmSession(requester, sessionId);
    }
    const warmAgent = async () => {
      try {
        const init = { signal: AbortSignal.timeout(warmupTimeoutMs), credentialServiceInvocationToken };
        mark('dispatch');
        const response = namedSession === undefined ? await upstream.invoke(JSON.stringify(input), input.threadId, init)
          : await runRuntimeWriter(() => sessionMetadata.beginDispatch(namedSession.owner, namedSession.session.session_id, namedSession.session.filing_user_id), { timeoutMs: 0 }, upstream, namedSession.session, async (writer) => {
            input.forwardedProps.sessionUserId = writer.session.filing_user_id;
            await forwardTurnIdentity(credentialSource, input.forwardedProps, {
              actorId: namedSession.accountActorId, filingActorId: writer.session.filing_user_id,
              sessionId: input.threadId, startedAt: new Date().toISOString(),
            });
            mark('identity');
            forwardSnapshotEpoch(input.forwardedProps, writer);
            return writer.invoke(JSON.stringify(input), input.threadId, init);
          });
        mark('invoke');
        if (response.status >= 400) {
          await response.body?.cancel();
          return c.json({ error: 'AgentCore warmup failed', details: `HTTP ${response.status}` }, 502);
        }
        const credentials = credentialValues(input.forwardedProps as Record<string, unknown>, bot.credentialProps, credentialServiceInvocationToken);
        const text = await response.text();
        mark('answer');
        const failure = await runError(text, credentials);
        if (failure !== null) {
          return c.json({ error: 'AgentCore warmup failed', details: turnErrorDetails(failure, credentials) }, 502);
        }
      } catch (error) {
        if (error instanceof SessionUnissuedError || error instanceof SessionReadOnlyError) throw error;
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
