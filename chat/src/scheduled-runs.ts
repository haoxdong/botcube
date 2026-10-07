import type { TurnMemory } from './turn-memory.js';
import type { TurnMemoryLease } from './session-metadata.js';
import { randomUUID } from 'node:crypto';
import { contentToText, type RunAgentInput, type ToolCallResultEvent } from '@ag-ui/client';
import { DescribeTasksCommand, ECSClient } from '@aws-sdk/client-ecs';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AgentDocuments } from './agent-documents.js';
import type { ChatServiceCartridge } from './cartridge.js';
import { accountDefaultModel, accountModelList, namedModel } from './models.js';
import type { ScheduledRunMessage, ScheduledTask, ScheduledTasks } from './scheduled-tasks.js';
import type { SessionApi } from './session-api.js';
import type { SessionMetadata } from './session-metadata.js';
import { sseFrameData, turnCredentialGuard, turnCredentials, turnErrorDetails } from './turn-stream.js';
import { recordTurnSummary, turnActivity, type TurnSummarizer } from './turn-summaries.js';
import type { Upstream } from './upstream.js';

export interface ScheduledRunDeps {
  turnMemory?: TurnMemory | null;
  turnMemoryUrl?: string | undefined;
  cartridge: ChatServiceCartridge;
  sessionMetadata: SessionMetadata;
  agentDocuments: AgentDocuments;
  invokeSessionApi: SessionApi;
  scheduledTasks: ScheduledTasks;
  upstream: Upstream | null;
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
 * Run a scheduled task: its prompt is the first Turn of a fresh Side Chat, and
 * a summary of the outcome is posted to the account's Main Chat. A run that
 * fails, or needs the user to sign in, says so there (ADR 0030).
 */
export async function runScheduledTask(deps: ScheduledRunDeps, { owner, taskId }: ScheduledRunMessage): Promise<void> {
  const { cartridge, sessionMetadata, invokeSessionApi } = deps;
  const task = await deps.scheduledTasks.get(owner, taskId);
  // A deleted or paused schedule may still deliver a run it had queued.
  if (task === null || task.paused) return;
  const filingUserId = cartridge.filingUserId(owner);
  const post = async (summary: string) => {
    const mainChat = await sessionMetadata.mainChat(owner);
    const messageId = randomUUID();
    const userId = await sessionMetadata.recordTurn(owner, mainChat, { filingUserId, title: task.title, messageId });
    await invokeSessionApi({ operation: 'post', sessionId: mainChat, userId, content: summary, messageId });
  };
  let summary: string;
  try {
    summary = await runInSideChat(deps, owner, task, filingUserId);
  } catch (error) {
    // The Main Chat hears of every failed run; the delivery still fails, so the queue redelivers it.
    await post(`Scheduled task "${task.title}" failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  await post(summary);
}

/** Run the task's prompt as the first Turn of a fresh Side Chat; answers the Main Chat summary of its outcome. */
async function runInSideChat(
  deps: ScheduledRunDeps,
  owner: string,
  task: ScheduledTask,
  filingUserId: string,
): Promise<string> {
  const { cartridge, sessionMetadata } = deps;
  if (deps.upstream === null) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
  const sideChat = randomUUID();
  const messageId = randomUUID();
  const requester = await cartridge.scheduledRequester(owner);
  // The task's chosen model, else the account's default.
  const model =
    task.model === undefined
      ? accountDefaultModel(await accountModelList(cartridge, requester))
      : await namedModel(cartridge, requester, task.model);
  const input: RunAgentInput = {
    threadId: sideChat,
    runId: randomUUID(),
    messages: [{ id: messageId, role: 'user', content: task.prompt }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { model: model.key },
  };
  const initialMessages = structuredClone(input.messages);
  const running = { startedAt: new Date().toISOString(), runId: input.runId };
  const sessionUserId = await sessionMetadata.recordTurn(owner, sideChat, {
    filingUserId,
    title: task.title,
    provider: model.provider,
    messageId,
    running,
  });
  let output: RunOutput;
  let memoryLease: TurnMemoryLease | undefined;
  try {
    const payload = await cartridge.invocationPayload(input, requester, model);
    const documents = await deps.agentDocuments.get(owner, cartridge.agentDocuments);
    payload.forwardedProps.agentIdentity = documents.agentIdentity;
    payload.forwardedProps.soul = documents.soul;
    payload.forwardedProps.sessionUserId = sessionUserId;
    delete payload.forwardedProps.turnMemory;
    if (deps.turnMemory) {
      const capability = await deps.turnMemory.start({ owner, accountActorId: cartridge.filingUserId(owner),
        filingUserId: sessionUserId, sessionId: sideChat, runId: input.runId, startedAt: running.startedAt });
      memoryLease = capability.lease;
      payload.forwardedProps.turnMemory = { token: capability.token, url: deps.turnMemoryUrl };
    }
    output = await readRun(
      await deps.upstream.invoke(JSON.stringify(payload), sideChat),
      deps.upstream.label,
      turnCredentials(payload.forwardedProps, cartridge.credentialProps),
      initialMessages,
    );
  } finally {
    if (deps.turnMemory) await deps.turnMemory.end(memoryLease, owner, sideChat, running, undefined);
    else await sessionMetadata.turnEnded(owner, sideChat, running, undefined);
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
    ? `Scheduled task "${task.title}" could not finish: ${signIn}`
    : output.error !== null
      ? `Scheduled task "${task.title}" failed: ${output.error}`
      : `Scheduled task "${task.title}": ${answer ?? 'finished without an answer.'}`;
}

/** The queue that schedules deliver their runs to. */
export interface RunQueue {
  receive(signal: AbortSignal): Promise<{ body: string; receipt: string }[]>;
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
      return (Messages ?? []).map(({ Body, ReceiptHandle }) => {
        if (Body === undefined || ReceiptHandle === undefined) {
          throw new Error('Scheduled run delivery is missing its Body or ReceiptHandle');
        }
        return { body: Body, receipt: ReceiptHandle };
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
  run: (message: ScheduledRunMessage) => Promise<void>,
  draining: () => Promise<boolean>,
  onFailure?: (error: unknown) => void,
): () => void {
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  void (async () => {
    // Stryker disable next-line BlockStatement: an emptied loop spins synchronously forever, hanging any test as a timeout
    while (!stopped()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- checked before every receive
        if (await draining()) {
          console.log('This Chat Service task is draining; it takes no more scheduled runs');
          return;
        }
      } catch (error) {
        console.error('Scheduled runs stopped: cannot tell whether this task is draining', error);
        if (onFailure === undefined) throw error;
        onFailure(error);
        return;
      }
      // Stryker disable next-line BlockStatement: an emptied try spins synchronously forever, hanging any test as a timeout
      try {
        // eslint-disable-next-line no-await-in-loop -- runs are taken one at a time
        for (const { body, receipt } of await queue.receive(stop.signal)) {
          // eslint-disable-next-line no-await-in-loop -- runs are taken one at a time
          await run(JSON.parse(body) as ScheduledRunMessage);
          // eslint-disable-next-line no-await-in-loop -- runs are taken one at a time
          await queue.delete(receipt);
        }
      } catch (error) {
        if (stopped()) return;
        console.error('Scheduled run failed', error);
        // eslint-disable-next-line no-await-in-loop -- back off before the next receive
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  })();
  return () => stop.abort();
}
