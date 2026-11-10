"use client";

import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";

import { takeOpeningResponse } from "botcube-ui-web/opening-requests";

import { tap } from "rxjs";
import { temporaryChatFetch, type TemporaryChat } from "botcube-ui-web/temporary-chat";
import {
  EventType,
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
  /** A scheduled task's Side Chat, which the drawer marks with a clock. */
  scheduled?: true;
  read_at?: string;
  turn_completed_at?: string;
}

export function isUnread(chat: Pick<ConversationEntry, "read_at" | "turn_completed_at">): boolean {
  return chat.turn_completed_at !== undefined && chat.read_at !== chat.turn_completed_at;
}

interface ThreadsResponse {
  threads: Partial<ConversationEntry>[];
  mainChat?: Partial<ConversationEntry>;
}

function normalizeConversation(value: Partial<ConversationEntry>): ConversationEntry | null {
  if (typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title ? value.title : "Untitled conversation",
    created_at: typeof value.created_at === "string" ? value.created_at : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
    ...(value.read_at === undefined ? {} : { read_at: value.read_at }),
    ...(value.turn_completed_at === undefined ? {} : { turn_completed_at: value.turn_completed_at }),
    ...(value.scheduled === true ? { scheduled: true } : {}),
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
  /** When that running Turn started, an ISO time. */
  runningSince?: string;
  /** Why the Session's latest Turn failed, as its client was told, even when none was attached. */
  failure?: SavedTurnFailure;
  /** A Session from before the one Session ID cutover takes no more Turns; replay still reads it. */
  readOnly?: boolean;
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

/** The chat list and its server-owned read state. */
export async function fetchChatList({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ threads: ConversationEntry[]; mainChat?: ConversationEntry }> {
  const response = await request(fetchImpl, `${chatServiceUrl}/threads`, "fetch threads");
  const body = (await response.json()) as ThreadsResponse;
  const mainChat = body.mainChat === undefined ? null : normalizeConversation(body.mainChat);
  return {
    threads: body.threads.map(normalizeConversation).filter((entry): entry is ConversationEntry => entry !== null),
    ...(mainChat === null ? {} : { mainChat }),
  };
}

export async function createSideChat({ chatServiceUrl, fetchImpl = fetch }: { chatServiceUrl: string; fetchImpl?: typeof fetch }): Promise<{ id: string }> {
  const response = await request(fetchImpl, `${chatServiceUrl}/threads`, "create a Side Chat", { method: "POST" });
  return await response.json() as { id: string };
}

export async function markChatRead(chatServiceUrl: string, id: string, observed: string | { runId: string }): Promise<void> {
  await request(fetch, `${chatServiceUrl}/threads/${encodeURIComponent(id)}/read`, "mark chat read", {
    method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(typeof observed === "string" ? { completedAt: observed } : observed),
  });
}

/** The Main Chat the user lands in, with its messages so far. */
export async function fetchMainChat({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ReplayedSession & { id: string }> {
  const url = `${chatServiceUrl}/main-chat`;
  const opening = takeOpeningResponse(url);
  const answered = opening === null ? null : await opening;
  // A browser without an account cookie must first let /account/session create it.
  const response = answered !== null && answered.status !== 401 ? answered : await request(fetchImpl, url, "open the Main Chat");
  if (!response.ok) throw new ChatServiceError("open the Main Chat", response.status);
  return withRunningCallsUnanswered((await response.json()) as ReplayedSession & { id: string });
}

/** A stopped Turn's cut call keeps its answer. */
function withRunningCallsUnanswered<T extends ReplayedSession>(read: T): T {
  if (read.running !== true) return read;
  let end = read.messages.length;
  while (end > 0 && read.messages[end - 1]?.role === "tool") end -= 1;
  const isPlaceholder = (message: Message) => message.role === "tool" && typeof message.content === "string" && UNANSWERED_CALL.test(message.content);
  return { ...read, messages: [...read.messages.slice(0, end), ...read.messages.slice(end).filter((message) => !isPlaceholder(message))] };
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
  return withRunningCallsUnanswered((await response.json()) as ReplayedSession);
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

/** Name a Side Chat; the Chat Service answers with the name it saved. */
export async function renameSideChat({
  id,
  title,
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  id: string;
  title: string;
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ConversationEntry> {
  const response = await request(fetchImpl, `${chatServiceUrl}/threads/${id}`, "rename thread", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return (await response.json()) as ConversationEntry;
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
  /** Its stream sent RUN_FINISHED or RUN_ERROR, so a Stop detaches it: an abort would end it a second time. */
  ended: boolean;
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
  private readonly fullContext: boolean;
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
    fullContext = false,
  }: {
    fullContext?: boolean;
    url: string;
    threadId: string;
    messages: readonly Message[];
    fetchImpl: (url: string, requestInit: RequestInit) => Promise<Response>;
    onStopFailed: (error: Error) => void;
  }) {
    super({ url, threadId, fetch: fetchImpl, initialMessages: [...messages] });
    this.savedMessages = [...messages];
    this.fullContext = fullContext;
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
        if (turn.ended) void this.detachActiveRun();
        else super.abortRun();
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

  /** Whether the Turn streaming here has started: its RUN_STARTED has arrived. */
  runStarted(): boolean {
    return this.turn?.active === true && this.turn.admitted;
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
    if (this.fullContext) return super.requestInit({
      ...input,
      messages: input.messages.flatMap((message) => {
        if (message.role !== "assistant" || !message.toolCalls?.some(({ id }) => this.stoppedCallIds.has(id))) return [message];
        const toolCalls = message.toolCalls.filter(({ id }) => !this.stoppedCallIds.has(id));
        return message.content || toolCalls.length > 0 ? [{ ...message, toolCalls }] : [];
      }),
    });
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
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        heldMessageIds: held.map(({ id }) => id),
        heldToolCallIds: held.flatMap((message) => (message.role === "assistant" ? message.toolCalls ?? [] : []).map(({ id }) => id)),
      },
    });
  }

  // AG-UI hands every lifecycle step of a run the same subscriber list, so a subscriber added to it hears the rest of the run.
  // Once that run ends, a subscriber added to it hears nothing more from it.
  protected override async onInitialize(input: RunAgentInput, subscribers: AgentSubscriber[]): Promise<void> {
    this.runSubscribers = subscribers;
    const turn: StreamingTurn = { runId: input.runId, admitted: false, active: true, stop: "idle", toolCallIds: new Set(), ended: false };
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

  // AG-UI's verifier ends the run as each event leaves here, before the subscribers hear it; a subscriber still
  // awaiting can hold that back past the Stop's acknowledgement, so the stream's end is marked here.
  override run(input: RunAgentInput) {
    const turn = this.turn;
    return super.run(input).pipe(tap((event) => {
      if (turn && (event.type === EventType.RUN_ERROR || event.type === EventType.RUN_FINISHED)) turn.ended = true;
    }));
  }
}

export function toolCancellationStore(agent: AbstractAgent): ToolCancellationStore {
  return agent instanceof SavedMessagesHttpAgent ? agent.cancellations : emptyCancellationStore;
}

/** Whether the user stopped `agent`'s streaming Turn here, rather than a newer Turn replacing it. */
export function stoppedHere(agent: AbstractAgent): boolean {
  return agent instanceof SavedMessagesHttpAgent && agent.stoppedHere();
}

/** Whether `agent`'s Turn streaming here has started: its RUN_STARTED has arrived. */
export function runStarted(agent: AbstractAgent): boolean {
  return agent instanceof SavedMessagesHttpAgent && agent.runStarted();
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
  fetchImpl = fetch,
  onStopFailed,
  temporaryChat,
}: {
  chatServiceUrl: string;
  temporaryChat?: TemporaryChat;
  threadId: string;
  messages: readonly Message[];
  fetchImpl?: (url: string, requestInit: RequestInit) => Promise<Response>;
  /** Why a Stop could not stop the Turn on the server. */
  onStopFailed: (error: Error) => void;
}): HttpAgent {
  if (temporaryChat !== undefined && temporaryChat.sessionId !== threadId) throw new Error('Temporary chat capability does not match the chat');
  return new SavedMessagesHttpAgent({
    url: chatServiceUrl,
    threadId,
    messages,
    fetchImpl: temporaryChat === undefined ? credentialsIncludingFetch(fetchImpl) : temporaryChatFetch(chatServiceUrl, temporaryChat, fetchImpl),
    fullContext: temporaryChat !== undefined,
    onStopFailed,
  });
}
