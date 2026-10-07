"use client";

import {
  HttpAgent,
  type AbstractAgent,
  type AgentSubscriber,
  type Message,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client";

/** A Side Chat as the Chat Service lists it. */
export interface ConversationEntry {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
}

interface ThreadsResponse {
  threads: Partial<ConversationEntry>[];
}

function normalizeConversation(value: Partial<ConversationEntry>): ConversationEntry | null {
  if (typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title ? value.title : "Untitled conversation",
    created_at: typeof value.created_at === "string" ? value.created_at : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

/** A request the Chat Service answered with a failure status. */
export class ChatServiceError extends Error {
  constructor(
    what: string,
    readonly status: number,
  ) {
    super(`Failed to ${what}: ${status}`);
  }
}

async function request(
  fetchImpl: (url: string, requestInit: RequestInit) => Promise<Response>,
  url: string,
  what: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetchImpl(url, { cache: "no-store", credentials: "include", ...init });
  if (!response.ok) {
    throw new ChatServiceError(what, response.status);
  }
  return response;
}

/** A model the account may run its Turns on, as `GET /agent/models` lists it. */
export interface AgentModel {
  key: string;
  label: string;
  description?: string;
  /** A started Session takes only its first Turn's provider's models. */
  provider: string;
}

/** A failed account catalog, with independently available server-owned Cartridge choices. */
export class ModelCatalogError extends Error {
  constructor(message: string, readonly cartridgeModels: AgentModel[] | null) {
    super(message);
  }
}

/** A replayed Session: its messages, and its model provider once it has a model Turn. */
export interface ReplayedSession {
  provider?: string;
  messages: Message[];
  /** The Session's latest Turn still runs on the server, as after a reload mid-Turn. */
  running?: boolean;
  /** That running Turn's run ID, which its Stop names. */
  runId?: string;
  /** Why the Session's latest Turn failed, as its client was told, even when none was attached. */
  failure?: SavedTurnFailure;
}

/** Why a Turn failed, as the Chat Service recorded it. */
export interface SavedTurnFailure {
  runId: string;
  code?: string;
  message: string;
}

/** The models the account may run its Turns on; the first is the default. */
export async function fetchAgentModels({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<AgentModel[]> {
  const response = await fetchImpl(`${chatServiceUrl}/agent/models`, { cache: "no-store", credentials: "include" });
  if (!response.ok) {
    if (response.status === 502 || response.status === 503) {
      let body: { detail?: string; cartridgeModels?: AgentModel[] } | undefined;
      try {
        body = await response.json() as typeof body;
      } catch (cause) {
        throw new Error(`Failed to load the models: ${response.status}: invalid catalog error response`, { cause });
      }
      throw new ModelCatalogError(
        `Failed to load the models: ${response.status}${body?.detail ? `: ${body.detail}` : ""}`,
        Array.isArray(body?.cartridgeModels) ? body.cartridgeModels : null,
      );
    }
    throw new Error(`Failed to load the models: ${response.status}`);
  }
  return ((await response.json()) as { models: AgentModel[] }).models;
}

/** The Side Chats, newest activity first. */
export async function fetchSideChats({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ConversationEntry[]> {
  const response = await request(fetchImpl, `${chatServiceUrl}/threads`, "fetch threads");
  const body = (await response.json()) as ThreadsResponse;
  return body.threads
    .map(normalizeConversation)
    .filter((entry): entry is ConversationEntry => entry !== null);
}

/** The Main Chat the user lands in, with its messages so far. */
export async function fetchMainChat({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ReplayedSession & { id: string }> {
  const response = await request(fetchImpl, `${chatServiceUrl}/main-chat`, "open the Main Chat");
  return (await response.json()) as ReplayedSession & { id: string };
}

export async function openConversation({
  id,
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  id: string;
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ReplayedSession> {
  const response = await request(fetchImpl, `${chatServiceUrl}/threads/${id}`, "replay thread");
  return (await response.json()) as ReplayedSession;
}

/** Ask the Chat Service to stop the Session's Turn `runId`; a Turn whose client went away runs on until then. */
export async function stopTurn({
  id,
  runId,
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  id: string;
  runId: string;
  chatServiceUrl: string;
  fetchImpl?: (url: string, requestInit: RequestInit) => Promise<Response>;
}): Promise<void> {
  await request(fetchImpl, `${chatServiceUrl}/threads/${id}/stop`, "stop the Turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
}

export async function deleteConversation({
  id,
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  id: string;
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await request(fetchImpl, `${chatServiceUrl}/threads/${id}`, "delete thread", { method: "DELETE" });
}


interface StreamingTurn {
  runId: string;
  admitted: boolean;
  active: boolean;
  stop: "idle" | "queued" | "pending" | "accepted";
  toolCallIds: Set<string>;
}

export interface ToolCancellationStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReadonlySet<string>;
}

const emptyStoppedCallIds: ReadonlySet<string> = new Set();
const emptyCancellationStore: ToolCancellationStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => emptyStoppedCallIds,
};

class SavedMessagesHttpAgent extends HttpAgent {
  private stoppedCallIds: ReadonlySet<string> = emptyStoppedCallIds;
  private readonly cancellationListeners = new Set<() => void>();
  readonly cancellations: ToolCancellationStore = {
    subscribe: (listener) => {
      this.cancellationListeners.add(listener);
      return () => { this.cancellationListeners.delete(listener); };
    },
    getSnapshot: () => this.stoppedCallIds,
  };
  private readonly savedMessages: Message[];
  private readonly onStopFailed: (error: Error) => void;
  /** The subscribers the latest run reports to; AG-UI fixes them when the run starts. */
  private runSubscribers: AgentSubscriber[] | undefined;
  private turn: StreamingTurn | undefined;

  constructor({
    url,
    threadId,
    messages,
    fetchImpl,
    onStopFailed,
  }: {
    url: string;
    threadId: string;
    messages: readonly Message[];
    fetchImpl: (url: string, requestInit: RequestInit) => Promise<Response>;
    onStopFailed: (error: Error) => void;
  }) {
    super({ url, threadId, fetch: fetchImpl, initialMessages: [...messages] });
    this.savedMessages = [...messages];
    this.onStopFailed = onStopFailed;
  }

  /** A Turn runs on after its stream closes, so a Stop also asks the Chat Service to stop it. */
  override abortRun(): void {
    const turn = this.turn;
    if (!this.isRunning || !turn?.active || turn.stop !== "idle") return;
    turn.stop = "queued";
    this.sendStop(turn);
  }

  private sendStop(turn: StreamingTurn): void {
    if (!turn.admitted || turn.stop !== "queued") return;
    turn.stop = "pending";
    stopTurn({ id: this.threadId, runId: turn.runId, chatServiceUrl: this.url, fetchImpl: this.fetch }).then(
      () => {
        if (this.turn !== turn || !turn.active || !this.isRunning) return;
        turn.stop = "accepted";
        this.recordStoppedCalls(turn);
        super.abortRun();
      },
      (error: unknown) => {
        console.error(`Stopping the Turn failed thread_id=${this.threadId} run_id=${turn.runId}`, error);
        if (this.turn !== turn || !turn.active || !this.isRunning) return;
        turn.stop = "idle";
        this.onStopFailed(error as Error);
      },
    );
  }

  private recordStoppedCalls(turn: StreamingTurn): void {
    const completed = new Set(this.messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []));
    const unresolved = [...turn.toolCallIds].filter((id) => !completed.has(id) && !this.stoppedCallIds.has(id));
    if (unresolved.length === 0) return;
    this.stoppedCallIds = new Set([...this.stoppedCallIds, ...unresolved]);
    for (const listener of this.cancellationListeners) listener();
  }

  /** Whether the user stopped the Turn streaming here, so the Harness's TURN_STOPPED ending it is no failure. */
  stoppedHere(): boolean {
    return this.isRunning && this.turn !== undefined && this.turn.stop !== "idle";
  }

  override async connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    const result = await super.connectAgent(parameters, subscriber);
    if (this.savedMessages.length > 0 && this.messages.length === 0) {
      this.setMessages([...this.savedMessages]);
    }
    return result;
  }

  /**
   * A view opened mid-Turn, such as the Agent Computer, hears the rest of that Turn,
   * its end included: otherwise its Stop stays up after the Turn stops.
   */
  override subscribe(subscriber: AgentSubscriber): { unsubscribe: () => void } {
    const subscription = super.subscribe(subscriber);
    const run = this.runSubscribers;
    run?.push(subscriber);
    return {
      unsubscribe: () => {
        subscription.unsubscribe();
        const index = run?.indexOf(subscriber) ?? -1;
        if (index >= 0) run?.splice(index, 1);
      },
    };
  }

  /**
   * The Harness holds the Session, so a Turn sends only the user's new messages. It names the messages and
   * tool calls the client already holds: the Chat Service cannot check what a stream appends to those.
   */
  protected override requestInit(input: RunAgentInput): RequestInit {
    let first = input.messages.length;
    while (first > 0 && input.messages[first - 1]?.role === "user") first -= 1;
    const sent = input.messages.slice(first);
    const sentIds = new Set(sent.map(({ id }) => id));
    const held = this.messages.filter(({ id }) => !sentIds.has(id));
    return super.requestInit({
      ...input,
      messages: sent,
      forwardedProps: {
        ...input.forwardedProps,
        heldMessageIds: held.map(({ id }) => id),
        heldToolCallIds: held.flatMap((message) => (message.role === "assistant" ? message.toolCalls ?? [] : []).map(({ id }) => id)),
      },
    });
  }

  // AG-UI hands every lifecycle step of a run the same subscriber list, so a subscriber added to it hears the rest of the run.
  // Once that run ends, a subscriber added to it hears nothing more from it.
  protected override async onInitialize(input: RunAgentInput, subscribers: AgentSubscriber[]): Promise<void> {
    this.runSubscribers = subscribers;
    const turn: StreamingTurn = { runId: input.runId, admitted: false, active: true, stop: "idle", toolCallIds: new Set() };
    this.turn = turn;
    subscribers.unshift({
      onRunStartedEvent: ({ event }) => {
        if (this.turn !== turn || !turn.active || event.runId !== turn.runId || event.threadId !== input.threadId) return;
        turn.admitted = true;
        this.sendStop(turn);
      },
      onToolCallStartEvent: ({ event }) => {
        if (this.turn === turn && turn.active) turn.toolCallIds.add(event.toolCallId);
      },
      onRunErrorEvent: ({ event }) => {
        if (this.turn === turn && turn.active && event.code === "TURN_STOPPED") this.recordStoppedCalls(turn);
      },
      onRunFinalized: () => { turn.active = false; },
    });
    await super.onInitialize(input, subscribers);
  }
}

export function toolCancellationStore(agent: AbstractAgent): ToolCancellationStore {
  return agent instanceof SavedMessagesHttpAgent ? agent.cancellations : emptyCancellationStore;
}

/** Whether the user stopped `agent`'s streaming Turn here, rather than a newer Turn replacing it. */
export function stoppedHere(agent: AbstractAgent): boolean {
  return agent instanceof SavedMessagesHttpAgent && agent.stoppedHere();
}

/** Why a Stop could not stop the Turn on the server. */
export function stopFailure(error: Error): string {
  return `The Turn could not be stopped: ${error.message}`;
}

export function credentialsIncludingFetch(
  fetchImpl: (url: string, requestInit: RequestInit) => Promise<Response> = fetch,
): (url: string, requestInit: RequestInit) => Promise<Response> {
  return (url, requestInit) => fetchImpl(url, {
    ...requestInit,
    credentials: "include",
  });
}

export function buildDirectAgent({
  chatServiceUrl,
  threadId,
  messages,
  fetchImpl = credentialsIncludingFetch(),
  onStopFailed,
}: {
  chatServiceUrl: string;
  threadId: string;
  messages: readonly Message[];
  fetchImpl?: (url: string, requestInit: RequestInit) => Promise<Response>;
  /** Why a Stop could not stop the Turn on the server. */
  onStopFailed: (error: Error) => void;
}): HttpAgent {
  return new SavedMessagesHttpAgent({
    url: chatServiceUrl,
    threadId,
    messages,
    fetchImpl,
    onStopFailed,
  });
}
