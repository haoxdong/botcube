import { forwardTurnIdentity, type TurnIdentity } from './turn-identity.js';
import { contentToText, type RunAgentInput, type ToolCallResultEvent } from '@ag-ui/client';
import { DescribeTasksCommand, ECSClient } from '@aws-sdk/client-ecs';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AgentDocuments } from './agent-documents.js';
import { HttpError, type ChatServiceCartridge } from './cartridge.js';
import { accountDefaultModel, accountModelList, namedModel } from './models.js';
import { fired, type ScheduledRunMessage, type ScheduledTask, type ScheduledTaskRun, type ScheduledTasks } from './scheduled-tasks.js';
import type { ScheduledRunCard, SessionApi } from './session-api.js';
import { SessionBusyError, SessionDeletedError, type SessionMetadata } from './session-metadata.js';
import { sseFrameData, turnCredentialGuard, turnCredentials, turnErrorDetails } from './turn-stream.js';
import { recordTurnSummary, turnActivity, type TurnSummarizer } from './turn-summaries.js';
import type { sessionLifecycle } from './session-lifecycle.js';
import type { ScheduledDelivery, ScheduledRunStore } from './scheduled-run-store.js';

export interface ScheduledRunDeps {
  runtimeNamespaceRequired: boolean;
  /** Null: the Chat Service has no keys and forwards no Turn identity. */
  turnIdentity: TurnIdentity | null;
  cartridge: ChatServiceCartridge;
  sessionMetadata: SessionMetadata;
  agentDocuments: AgentDocuments;
  invokeSessionApi: SessionApi;
  scheduledTasks: Pick<ScheduledTasks, 'get' | 'recordRun' | 'retire'>;
  upstream: ReturnType<typeof sessionLifecycle> | null;
  summarizeTurn: TurnSummarizer;
}

/** What one run's stream said: its agent messages' text in order, its tool results, and any run error. */
interface RunOutput {
  texts: string[];
  toolResults: string[];
  error: string | null;
}

/** Read a Turn's AG-UI event stream to its end. */
async function readRun(response: Response, label: string, credentials: readonly string[], initialMessages: readonly unknown[]): Promise<RunOutput> {
  if (!response.ok) {
    return { texts: [], toolResults: [], error: `${label} returned HTTP ${response.status}: ${turnErrorDetails((await response.text()).trim(), credentials)}` };
  }
  const texts = new Map<string, string>();
  const toolResults: string[] = [];
  const guard = turnCredentialGuard(credentials, initialMessages);
  let error: string | null = null;
  let finished = false;
  const withheld: RunOutput = { texts: [], toolResults: [], error: "The agent's answer carried the Turn's credentials, so it was withheld" };
  for (const frame of (await response.text()).split(/\r?\n\r?\n/)) {
    // JSON.parse errors include their malformed input, so inspect the wire first.
    if (guard.leaks(frame, [])) return withheld;
    const data = sseFrameData(frame.split(/\r?\n/));
    if (data === null) continue;
    const event = JSON.parse(data) as Record<string, unknown>;
    if (guard.leaks('', [event])) return withheld;
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const id = String(event.messageId);
      texts.set(id, (texts.get(id) ?? '') + String(event.delta));
    } else if (event.type === 'TOOL_CALL_RESULT') {
      toolResults.push(contentToText(event.content as ToolCallResultEvent['content']));
    } else if (event.type === 'RUN_ERROR') {
      error = String(event.message);
    } else if (event.type === 'RUN_FINISHED') {
      finished = true;
    }
  }
  error ??= finished ? null : `${label} stream ended before RUN_FINISHED`;
  const output = { texts: [...texts.values()].map((text) => text.trim()).filter(Boolean), toolResults, error };
  // The scheduled consumer assembles its own text, independently of client snapshot replacement.
  return turnCredentialGuard(credentials).leaks('', [output]) ? withheld : output;
}

/**
 * Run a scheduled task: its prompt adds a Turn to its one Side Chat, and
 * a summary of the outcome is posted to the account's Main Chat. A run that
 * fails, or needs the user to sign in, says so there (ADR 0030).
 */
export async function runScheduledTask(deps: ScheduledRunDeps, { owner, taskId, deliveryId, deliveryFence }: ScheduledRunMessage & { deliveryId?: string }): Promise<void> {
  const { cartridge, sessionMetadata, invokeSessionApi } = deps;
  if (typeof deliveryId !== 'string' || deliveryId.trim() === '') throw new HttpError(503, 'Scheduled delivery identity is unavailable');
  const store = sessionMetadata.scheduledRuns;
  if (store === undefined) throw new HttpError(503, 'Scheduled delivery storage is unavailable');
  const previous = await store.get(owner, deliveryId, taskId);
  if (previous !== null && previous.phase !== 'reserved') return finishRedelivery(deps, store, previous);
  const deliveryContext = deliveryFence === undefined ? {} : { deliveryFence };
  const admission = await scheduledTaskAdmission(deps, store, owner, taskId, previous, deliveryContext);
  if (admission === null) return;
  const { executionOwner, task } = admission;
  if (deps.runtimeNamespaceRequired) await assertRuntimeNamespaceReady(sessionMetadata);
  const filingUserId = previous?.filingUserId ?? cartridge.filingUserId(owner);
  const mainChat = previous?.mainChat ?? await sessionMetadata.mainChat(owner, filingUserId);
  await assertReservedMainIdentity(sessionMetadata, owner, executionOwner, mainChat, previous?.mainFilingUserId);
  const delivery = previous === null ? await store.claim(owner, taskId, deliveryId, filingUserId, mainChat) : await store.reclaim(previous, executionOwner);
  await store.admit(delivery, executionOwner);
  await sessionMetadata.recordTurn(executionOwner, mainChat, { filingUserId: delivery.mainFilingUserId ?? filingUserId, title: task.title, messageId: delivery.postMessageId, postAcceptance: true });
  // Whether this run's request reached its Side Chat, so its card can open it there.
  const reached = { sideChat: false };
  const post = async (outcome: RunOutcome, failed = false) => {
    const scheduledRun: ScheduledRunCard = {
      ...(reached.sideChat ? { sideChat: delivery.sideChat, messageId: delivery.inputMessageId } : {}),
      title: task.title, ranAt: delivery.startedAt, ...outcome,
    };
    const messageId = delivery.postMessageId;
    const complete = await sessionMetadata.beginDispatch(executionOwner, mainChat, undefined, { messageId });
    if (complete.session === undefined) throw new HttpError(503, 'Scheduled post filing identity is unavailable');
    const userId = complete.session.filing_user_id;
    if (complete.markSucceeded === undefined) throw new HttpError(503, 'Scheduled post success registration is unavailable');
    const posting = await store.posting(delivery, complete, failed, lastRunStatus(outcome.status));
    await invokeSessionApi({ operation: 'post', sessionId: mainChat, userId, content: runSummary(scheduledRun), messageId, scheduledRun });
    await complete.markSucceeded('session-post', store.postedTransaction(posting));
    await complete();
    await store.complete(posting);
    return posting;
  };
  // The task's sheet shows how its latest run ended, once the Main Chat has heard.
  const recordLastRun = (status: ScheduledTaskRun['status']) => deps.scheduledTasks.recordRun(executionOwner, task.id, { at: delivery.startedAt, status });
  // A one-off leaves the account once the Main Chat has heard of its run, however it ended, since Scheduler deleted its
  // schedule when it fired; an Account Claim during the run may have moved it.
  const retire = async () => deps.scheduledTasks.retire(await store.executionOwner(delivery), task);
  let outcome: RunOutcome;
  try {
    // A one-off paused after it fired never runs again: its delivery only tells the Main Chat so.
    outcome = task.paused ? { status: 'skipped', text: 'the task was paused' } : await runInSideChat(deps, executionOwner, task, filingUserId, delivery, reached, deliveryContext);
  } catch (error) {
    if (error instanceof SessionDeletedError) throw error;
    // The Main Chat hears of every failed run; the delivery still fails, so the queue redelivers it.
    const posting = await post({ status: 'failed', text: error instanceof Error ? error.message : String(error) }, true);
    await settleFailedRun(error, async () => {
      await recordLastRun('failed');
      await retire();
      await store.retryFailed(posting);
    });
    throw error;
  }
  await post(outcome);
  const status = lastRunStatus(outcome.status);
  if (status !== undefined) await recordLastRun(status);
  await retire();
}

/** A failure to record a failed run, or retire its one-off, keeps the run's own failure beside it. */
async function settleFailedRun(runFailure: unknown, settle: () => Promise<void>): Promise<void> {
  try {
    await settle();
  } catch (settleFailure) {
    throw new AggregateError([runFailure, settleFailure], 'Scheduled run failed, and so did settling it');
  }
}

/** How a run ended, and its answer or why not. */
type RunOutcome = Pick<ScheduledRunCard, 'status' | 'text'>;

/** A skipped run ran nothing, so the task's Last run stays as it was. */
function lastRunStatus(status: RunOutcome['status']): ScheduledTaskRun['status'] | undefined {
  return status === 'skipped' ? undefined : status;
}

/** The run's Main Chat message as text: what the Main Chat's agent reads, and what a client without run cards shows. */
function runSummary({ title, status, text }: ScheduledRunCard): string {
  const said = { done: ':', failed: ' failed:', 'sign-in': ' could not finish:', skipped: ' skipped:' }[status];
  return `Scheduled task "${title}"${said} ${text}`;
}

async function scheduledTaskAdmission(deps: ScheduledRunDeps, store: ScheduledRunStore, owner: string, taskId: string, previous: ScheduledDelivery | null, delivery: Pick<ScheduledRunMessage, 'deliveryFence'>) {
  const executionOwner = previous === null ? owner : await store.executionOwner(previous);
  const task = await deps.scheduledTasks.get(executionOwner, taskId, delivery);
  // A paused task runs nothing; a paused one-off that fired still reaches the Main Chat, as it will never run.
  if (task === null || (task.paused && !fired(task))) {
    if (executionOwner !== owner) throw new HttpError(503, 'Reserved scheduled task is unavailable; delivery remains pending');
    return null;
  }
  if (!fired(task) && outsideBounds(task)) return null;
  return { executionOwner, task };
}

/** A redelivered run past its post: finish settling it, and fail it again if the run failed. */
async function finishRedelivery(deps: ScheduledRunDeps, store: ScheduledRunStore, previous: ScheduledDelivery): Promise<void> {
  await resumeScheduledDelivery(deps.sessionMetadata, previous, deps.scheduledTasks);
  await retireFinished(deps, store, previous);
  if (previous.failed) {
    await store.retryFailed(previous);
    throw new HttpError(503, 'Scheduled delivery previously failed; its Main Chat notification is complete');
  }
}

async function assertRuntimeNamespaceReady(sessionMetadata: SessionMetadata): Promise<void> {
  try {
    await sessionMetadata.checkRuntimeNamespaceReady();
  } catch (error) {
    console.error('Session Runtime namespace readiness failed', error);
    throw new HttpError(503, 'Session Runtime namespace is not ready');
  }
}

/** A redelivered run that already finished and posted: its one-off may not have left the account yet. */
async function retireFinished(deps: ScheduledRunDeps, store: ScheduledRunStore, previous: ScheduledDelivery): Promise<void> {
  const executionOwner = await store.executionOwner(previous);
  const task = await deps.scheduledTasks.get(executionOwner, previous.taskId);
  if (task !== null) await deps.scheduledTasks.retire(executionOwner, task);
}

async function assertReservedMainIdentity(sessionMetadata: SessionMetadata, owner: string, executionOwner: string, mainChat: string, filingUserId: string | undefined): Promise<void> {
  if (executionOwner === owner) return;
  const main = await sessionMetadata.get(executionOwner, mainChat);
  if (filingUserId === undefined || main?.filing_user_id !== filingUserId) throw new HttpError(503, 'Reserved scheduled Main Chat identity is unavailable; delivery remains pending');
}

async function resumeScheduledDelivery(sessionMetadata: SessionMetadata, previous: ScheduledDelivery, tasks: Pick<ScheduledTasks, 'recordRun'>): Promise<void> {
  const store = sessionMetadata.scheduledRuns;
  if (store === undefined) throw new HttpError(503, 'Scheduled delivery storage is unavailable');
  if (previous.phase !== 'completed') {
    if (previous.phase !== 'posted' || previous.postSession === undefined || previous.postToken === undefined || sessionMetadata.acknowledgeSuccessfulDispatch === undefined) {
      throw new HttpError(503, 'Scheduled delivery outcome is unproved; delivery remains pending');
    }
    await sessionMetadata.acknowledgeSuccessfulDispatch(previous.postSession, previous.postToken, 'session-post');
    await store.complete(previous);
  }
  // Its end may not have reached the task before the delivery failed; recording it again changes nothing.
  if (previous.status !== undefined) {
    await tasks.recordRun(await store.executionOwner(previous), previous.taskId, { at: previous.startedAt, status: previous.status });
  }
}

async function runInSideChat(
  deps: ScheduledRunDeps,
  owner: string,
  task: ScheduledTask,
  filingUserId: string,
  delivery: ScheduledDelivery,
  reached: { sideChat: boolean },
  deliveryContext: Pick<ScheduledRunMessage, 'deliveryFence'>,
): Promise<RunOutcome> {
  const { cartridge, sessionMetadata } = deps;
  if (deps.upstream === null) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
  const sideChat = delivery.sideChat;
  const messageId = delivery.inputMessageId;
  const requester = await cartridge.scheduledRequester(owner);
  // The task's chosen model, else the account's default.
  const model =
    task.model === undefined
      ? accountDefaultModel(await accountModelList(cartridge, requester))
      : await namedModel(cartridge, requester, task.model);
  const input: RunAgentInput = {
    threadId: sideChat,
    runId: delivery.runId,
    messages: [{ id: messageId, role: 'user', content: task.prompt }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { model: model.key },
  };
  const initialMessages = structuredClone(input.messages);
  const running = { startedAt: delivery.startedAt, runId: input.runId };
  const sessionUserId = await sessionMetadata.recordTurn(owner, sideChat, {
    filingUserId,
    title: task.title,
    provider: model.provider,
    messageId,
    running,
    scheduledTaskId: task.id,
  }).catch((error: unknown) => {
    if (error instanceof SessionBusyError) return null;
    throw error;
  });
  if (sessionUserId === null) return { status: 'skipped', text: 'the previous run was still going' };
  reached.sideChat = true;
  let output: RunOutput;
  try {
    const payload = await cartridge.invocationPayload(input, requester, model);
    const documents = await deps.agentDocuments.get(owner, cartridge.agentDocuments);
    payload.forwardedProps.agentIdentity = documents.agentIdentity;
    payload.forwardedProps.soul = documents.soul;
    payload.forwardedProps.sessionUserId = sessionUserId;
    // The prompt may still say how often to run; a run must not propose another task.
    payload.forwardedProps.scheduledRun = true;
    await forwardTurnIdentity(deps.turnIdentity, payload.forwardedProps, {
      actorId: cartridge.filingUserId(owner), filingActorId: sessionUserId, sessionId: sideChat, startedAt: running.startedAt,
    });
    const current = await deps.scheduledTasks.get(owner, task.id, deliveryContext);
    if (current === null) return { status: 'skipped', text: 'the task was no longer available' };
    const boundsChanged = current.startDate !== task.startDate || current.endDate !== task.endDate;
    if (!fired(current) && (current.paused || (boundsChanged && outsideBounds(current)))) return { status: 'skipped', text: 'the task was outside its active time window' };
    const complete = await sessionMetadata.beginDispatch(owner, sideChat, undefined, running);
    output = await readRun(
      await deps.upstream.invokeRegistered(JSON.stringify(payload), complete.session ?? { session_id: sideChat, filing_user_id: sessionUserId }, complete),
      deps.upstream.label,
      turnCredentials(payload.forwardedProps, cartridge.credentialProps),
      initialMessages,
    );
  } finally {
    await sessionMetadata.turnEnded(owner, sideChat, running, undefined);
  }
  const signIn = await cartridge.signInNeeded(owner, [...output.toolResults, ...output.texts]);
  const answer = output.texts.at(-1);
  const turn = { sessionId: sideChat, filingUserId: sessionUserId, messageId };
  if (signIn === null && output.error === null) {
    await recordTurnSummary(
      deps.summarizeTurn,
      (finished) => sessionMetadata.saveTurnSummary(owner, turn, finished),
      sideChat,
      { request: task.prompt, answer: answer ?? '' },
    );
  } else {
    // The Activity lists a run that could not finish by its request, failed on a run error.
    await sessionMetadata.saveTurnSummary(owner, turn, turnActivity(task.prompt, output.error ?? undefined));
  }
  return signIn !== null
    ? { status: 'sign-in', text: signIn }
    : output.error !== null
      ? { status: 'failed', text: output.error }
      : { status: 'done', text: answer ?? 'finished without an answer.' };
}

/** The queue that schedules deliver their runs to. */
export interface RunQueue {
  receive(signal: AbortSignal): Promise<{ body: string; receipt: string; deliveryId: string }[]>;
  delete(receipt: string): Promise<void>;
}

export function sqsRunQueue(
  queueUrl: string,
  // Stryker disable next-line ObjectLiteral: production's client; tests inject one pointed at moto
  sqs = new SQSClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
): RunQueue {
  return {
    async receive(signal) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20 }),
        { abortSignal: signal },
      );
      return (Messages ?? []).map(({ Body, ReceiptHandle, MessageId }) => {
        if (Body === undefined || ReceiptHandle === undefined || MessageId === undefined) {
          throw new Error('Scheduled run delivery is missing its Body, ReceiptHandle or MessageId');
        }
        return { body: Body, receipt: ReceiptHandle, deliveryId: MessageId };
      });
    },
    async delete(receipt) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
    },
  };
}

/**
 * Whether ECS has marked this task to stop. A deploy's old task keeps running
 * through the load balancer's deregistration delay, and only the ECS API shows
 * its desired status as STOPPED by then, so it describes its own task, named by
 * the ECS task metadata endpoint v4. Outside ECS it never drains.
 */
export function ecsTaskDraining(
  metadataUri: string | undefined,
  // Stryker disable next-line ObjectLiteral: production's client; tests stub its send
  ecs = new ECSClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
): () => Promise<boolean> {
  if (metadataUri === undefined) return async () => false;
  return async () => {
    const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`ECS task metadata answered HTTP ${response.status}`);
    const { Cluster, TaskARN } = (await response.json()) as { Cluster?: unknown; TaskARN?: unknown };
    if (typeof Cluster !== 'string' || typeof TaskARN !== 'string') throw new Error('ECS task metadata has no Cluster or TaskARN');
    const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster: Cluster, tasks: [TaskARN] }), {
      abortSignal: AbortSignal.timeout(5000),
    });
    const desiredStatus = tasks?.[0]?.desiredStatus;
    if (desiredStatus === undefined) throw new Error(`ECS describes no desired status for task ${TaskARN}`);
    return desiredStatus === 'STOPPED';
  };
}

/**
 * Take runs off the queue one at a time until stopped, or until this task is
 * draining, so a deploy hands the runs to the new revision. A run that throws
 * stays on the queue and is delivered again; the queue's redrive policy bounds it.
 */
export function pollScheduledRuns(
  queue: RunQueue,
  run: (message: ScheduledRunMessage & { deliveryId: string }) => Promise<void>,
  draining: () => Promise<boolean>,
  onFailure?: (error: unknown) => void,
  maintenance?: () => Promise<void>,
  maintenanceReadiness?: () => Promise<void>,
): () => void {
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  let maintenancePending: Promise<void> | undefined;
  let nextMaintenance = 0;
  const reportFailure = (failure: string, error: unknown) => {
    console.error(`Scheduled runs stopped: ${failure}`, error);
    stop.abort();
    if (onFailure === undefined) throw error;
    onFailure(error);
  };
  const maybeStartMaintenance = () => {
    if (maintenance === undefined || maintenancePending !== undefined || Date.now() < nextMaintenance) return;
    maintenancePending = maintenance().then(
      () => undefined,
      (error: unknown) => { reportFailure('expired task maintenance failed', error); },
    ).finally(() => {
      nextMaintenance = Date.now() + 60_000;
      maintenancePending = undefined;
    });
  };
  const receiveBatch = async () => {
    let failure = 'cannot tell whether this task is draining';
    try {
      if (await draining()) {
        console.log('This Chat Service task is draining; it takes no more scheduled runs');
        return null;
      }
      if (maintenance !== undefined || maintenanceReadiness !== undefined) {
        failure = 'expired task maintenance failed';
        await maintenanceReadiness?.();
        if (stopped()) return null;
        maybeStartMaintenance();
        failure = 'cannot tell whether this task is draining';
        if (await draining()) return null;
      }
      if (stopped()) return null;
      failure = 'queue receive failed';
      return await queue.receive(stop.signal);
    } catch (error) {
      if (failure === 'queue receive failed' && stopped()) return null;
      reportFailure(failure, error);
      return null;
    }
  };
  const executeBatch = async (messages: Awaited<ReturnType<RunQueue['receive']>>) => {
    try {
      for (const { body, receipt, deliveryId } of messages) {
        // eslint-disable-next-line no-await-in-loop -- runs are taken one at a time
        await run({ ...JSON.parse(body) as ScheduledRunMessage, deliveryId });
        // eslint-disable-next-line no-await-in-loop -- runs are taken one at a time
        await queue.delete(receipt);
      }
    } catch (error) {
      if (stopped()) return;
      console.error('Scheduled run failed', error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  };
  void (async () => {
    // Stryker disable next-line BlockStatement: an emptied loop spins synchronously forever, hanging any test as a timeout
    while (!stopped()) {
      // eslint-disable-next-line no-await-in-loop -- one receive batch at a time
      const messages = await receiveBatch();
      if (messages === null) return;
      // eslint-disable-next-line no-await-in-loop -- runs are taken one at a time
      await executeBatch(messages);
    }
  })();
  return () => stop.abort();
}

function outsideBounds(task: ScheduledTask): boolean {
  const now = Date.now();
  return (task.startDate !== undefined && now < Date.parse(task.startDate)) || (task.endDate !== undefined && now >= Date.parse(task.endDate));
}
