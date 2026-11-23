"use client";

import { Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "motion/react";

import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Key, type ReactElement, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
import { CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  type CopilotChatReasoningMessage,
  CopilotChatView,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
} from "@copilotkit/react-core/v2";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import type { AbstractAgent } from "@ag-ui/client";
import { holdEnter, stopOnEscapeNoMenuTook } from "./composer-keys";
import { runStarted, stoppedHere, toolCancellationStore, type SavedTurnFailure } from "./conversations";
import { endMoment, startMoment, type Moment } from "./latency";
import type { ModelList } from "./model-selection";
import { agentFiles } from "./agent-files";
import { ScheduledTaskProposalCard, type ScheduledTaskProposal } from "./scheduled-tasks";
import { OpenScheduledRun, type ReachedScheduledRun } from "./scheduled-run-card";
import { ReplyTurnRunning } from "./reply-turn";
import { watchOpening } from "./chat-opening";
import { webUiPlugin } from "@bot-ui";
import { AssistantMessage, USER_MESSAGE } from "./reading-message";
import { chatServiceUrl } from "../plugin/chat-service-url";
import { Button } from "@/components/pill-button";
import { ComposerFileChips, ComposerFilePicker, attachPastedImages, messageWithFiles, useComposerFiles, type ComposerFiles } from "./composer-files";
import { AddMenu, FileDropOverlay, useFileDrop } from "./composer-attach";
import { Composer } from "./composer";
import { ThoughtStep, ToolStep, worklogKey, worklogRows } from "./worklog";
import { showsProposalCard } from "./worklog-tools";
import { fitBubbles } from "./bubble-width";
import { PlotlyPrefetch } from "../components/plotly-bundle";
import { shows, useSteering, type PendingMessage, type Withdrawal } from "./steering";
import { WaitingMessages } from "./waiting-steering";
import { MessageEntranceRow, MessageEntranceHistory, type MessageEntrances } from "./message-entrance";
import { useAgentRunning, useRunEnded } from "./agent-running";
import { ThreadScrollView } from "./conversation-thread";

const MotionButton = motionElement.create(Button);

const UI_CONFIG = webUiPlugin.config;
const AGENT_ID = UI_CONFIG.agentId;
const CHAT_SERVICE_URL = chatServiceUrl();

function WelcomeScreen({ userName }: { userName?: string | undefined }) {
  const firstName = userName?.split(" ")[0];

  return (
    <div className="welcome-screen">
      <h1 className="welcome-title">{firstName ? `Hi ${firstName}, how can I help you?` : UI_CONFIG.title}</h1>
      <Presence>{!firstName && <motionElement.p {...presenceMotion} className="welcome-desc">{UI_CONFIG.subtitle}</motionElement.p>}</Presence>
    </div>
  );
}

function ToolCallRenderer({ agent }: { agent: AbstractAgent }) {
  const cancellations = toolCancellationStore(agent);
  const stoppedIds = useSyncExternalStore(cancellations.subscribe, cancellations.getSnapshot, cancellations.getSnapshot);
  useDefaultRenderTool({
    render: ({ name, toolCallId, status, parameters, result }) => {
      if (name === "propose_scheduled_task" && status === "complete" &&
        showsProposalCard(result)) {
        return (
          <ScheduledTaskProposalCard
            chatServiceUrl={CHAT_SERVICE_URL}
            proposalId={toolCallId}
            proposal={parameters as ScheduledTaskProposal}
            result={result}
          />
        );
      }
      return (
        <ToolStep
          id={toolCallId}
          name={name}
          params={parameters as Record<string, unknown> | undefined}
          status={status === "complete" ? "complete" : stoppedIds.has(toolCallId) ? "stopped" : "running"}
          output={status === "complete" ? result ?? undefined : undefined}
        />
      );
    },
  }, [[...stoppedIds]]);
  return null;
}

type Submit = NonNullable<CopilotChatInputProps["onSubmitMessage"]>;

const ComposerAccessory = createContext<React.ReactNode>(null);
const ComposerPicker = createContext<{ picker: ReactNode; autoFocus: boolean }>({ picker: null, autoFocus: false });
const SubmitTurn = createContext<((message: string, submit: Submit, retry?: () => void) => boolean) | null>(null);
const ComposerSubmit = createContext<{ current: Submit | null } | null>(null);
const ComposerStop = createContext<{ current: (() => void) | null } | null>(null);
const ServerTurn = createContext<{ running: boolean; stop: (() => void) | null }>({ running: false, stop: null });
const SteeringDrop = createContext<{ current: (() => void) | null } | null>(null);
const SteeringWaiting = createContext<{ waiting: PendingMessage[]; withdraw: (id: string) => Promise<Withdrawal>; sendNow: (id: string) => Promise<Withdrawal> } | null>(null);
type LentComposer = { edit: (content: string) => void; stopTurn: (() => void) | undefined };
const WaitingComposer = createContext<{ current: LentComposer | null } | null>(null);

function useDropSteering(): () => void {
  const holder = useContext(SteeringDrop);
  if (holder === null) throw new Error("Stop needs the ChatSurface that holds the chat's steering");
  return useCallback(() => {
    if (holder.current === null) throw new Error("Stop found no chat whose steering it could drop");
    holder.current();
  }, [holder]);
}
const AttachedFiles = createContext<ComposerFiles | null>(null);
/** The user put something into the composer: typed, pasted or attached a file. */
const Compose = createContext<() => void>(() => {});
const ReadOnlyChat = createContext<(() => void) | null>(null);

function sendWithFiles(message: string, attachedRef: RefObject<ComposerFiles | null>, submitTurn: NonNullable<React.ContextType<typeof SubmitTurn>>, submit: NonNullable<CopilotChatInputProps["onSubmitMessage"]>) {
  const attached = attachedRef.current;
  if (!attached) {
    submitTurn(message, submit);
    return;
  }
  if (!attached.sendable) return;
  const paths = attached.files.flatMap(({ state }) => (state.status === "uploaded" ? [state.path] : []));
  if (submitTurn(messageWithFiles(message, paths), submit, () => sendWithFiles(message, attachedRef, submitTurn, submit))) attached.clear();
}

function useComposerActions(submit: Submit | undefined, stop: (() => void) | undefined, running: boolean, mode: CopilotChatInputProps["mode"]) {
  const composerSubmit = useContext(ComposerSubmit);
  const composerStop = useContext(ComposerStop);
  useLayoutEffect(() => {
    if (composerSubmit !== null) composerSubmit.current = submit ?? null;
    if (composerStop !== null) composerStop.current = running && mode !== "transcribe" ? stop ?? null : null;
  });
}

function useLendComposer(text: { current: string }, onChange: (value: string) => void, stopTurn: (() => void) | undefined) {
  const holder = useContext(WaitingComposer);
  useLayoutEffect(() => {
    if (holder !== null) holder.current = { edit: (content) => onChange(text.current.trim() ? `${content}\n\n${text.current}` : content), stopTurn };
  });
}

function ThreadWaiting() {
  const steering = useContext(SteeringWaiting);
  const composer = useContext(WaitingComposer);
  if (!steering || !composer) return null;
  const sendNow = async (id: string) => {
    const outcome = await steering.sendNow(id);
    if (outcome === "withdrawn") composer.current?.stopTurn?.();
    return outcome;
  };
  return <WaitingMessages waiting={steering.waiting} withdraw={steering.withdraw} sendNow={sendNow} onEdit={({ content }) => composer.current?.edit(content)} />;
}

function ComposerInput(props: CopilotChatInputProps) {
  const accessory = useContext(ComposerAccessory);
  const { picker: modelPicker, autoFocus } = useContext(ComposerPicker);
  const submitTurn = useContext(SubmitTurn);
  const { stop: stopServerTurn } = useContext(ServerTurn);
  const dropSteering = useDropSteering();
  const attached = useContext(AttachedFiles);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  const picker = useRef<HTMLInputElement>(null);
  const held = attached?.sendable === false;
  const submit = props.onSubmitMessage;
  const [draft, setDraft] = useState(props.value ?? "");
  const value = props.value ?? draft;
  const fileOnly = !value.trim() && (attached?.files.length ?? 0) > 0;
  const sendFiles = fileOnly && submit && submitTurn ? () => sendWithFiles("", attachedRef, submitTurn, submit) : undefined;
  const stopsServerTurn = !props.isRunning && stopServerTurn !== null;
  const isRunning = props.isRunning || stopsServerTurn;
  const stopTurn = stopsServerTurn ? stopServerTurn : props.onStop;
  const stop = stopTurn && (() => {
    dropSteering();
    stopTurn();
  });
  useComposerActions(submit, stop, isRunning, props.mode);
  const compose = useContext(Compose);
  const text = useRef("");
  text.current = value;
  const onChange = (next: string) => { setDraft(next); props.onChange?.(next); if (next) compose(); };
  useLendComposer(text, onChange, stopTurn);
  const send = () => {
    if (sendFiles) {
      sendFiles();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || !submit) return;
    if (submitTurn) sendWithFiles(trimmed, attachedRef, submitTurn, submit);
    else submit(trimmed);
    onChange("");
  };
  return (
    <>
      {attached && <ComposerFilePicker picker={picker} add={attached.add} />}
      <Presence>{accessory && (
        <motionElement.div {...presenceMotion} className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:@3xl:px-0">
          <div className="composer-accessory">{accessory}</div>
        </motionElement.div>
      )}</Presence>
      <Composer
        value={value}
        onChange={onChange}
        onSend={send}
        onStop={stop}
        running={isRunning}
        canSend={!held && (sendFiles !== undefined || (value.trim() !== "" && submit !== undefined))}
        hasFiles={(attached?.files.length ?? 0) > 0}
        autoFocus={autoFocus}
        addMenu={attached && <AddMenu picker={picker} />}
        files={attached && <ComposerFileChips files={attached.files} onRetry={attached.retry} onRemove={attached.remove} />}
        picker={modelPicker}
        disclaimer={UI_CONFIG.disclaimer}
        onKeyDownCapture={holdEnter(held, isRunning, sendFiles)}
        onPaste={attached ? attachPastedImages(attached.add) : undefined}
      />
    </>
  );
}

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

interface TurnFailure {
  message: string;
  question?: string | undefined;
  retry?: () => void;
}

const RunError = createContext<TurnFailure | null>(null);

const RunStarted = createContext(false);
/** The current run has sent its end; its stream may still be closing. */
const RunEnded = createContext(false);

const OpensAt = createContext<string | null>(null);

const couldNotAnswer = (message: string): TurnFailure => ({ message: `The agent could not answer: ${message}` });
const busyRefusal = z.object({ code: z.literal("SESSION_BUSY"), detail: z.string() });

const ConversationScrollView = (props: ComponentProps<typeof CopilotChatView.ScrollView>) => (
  <ThreadScrollView {...props} opensAt={useContext(OpensAt)} />
);

/** The slot types its component with CopilotKit's sub-components, which it never reads, only renders. */
const ASSISTANT_MESSAGE_SLOT = AssistantMessage as typeof CopilotChatAssistantMessage;

/** CopilotKit types slots with its statics but only calls the component. */
const REASONING_MESSAGE = ThoughtStep as unknown as typeof CopilotChatReasoningMessage;

function MomentEnds({ moment }: { moment: Moment }) {
  useEffect(() => endMoment(moment), [moment]);
  return null;
}

const MESSAGE_ROWS_PER_PAGE = 4;

/** CopilotKit surrounds message-ID rows with custom slots, including empty ones. */
function pageStart(elements: ReactElement[], end: number, messageIds: Set<string>): number {
  let start = end;
  for (let rows = 0; start > 0 && rows < MESSAGE_ROWS_PER_PAGE; ) {
    start -= 1;
    const key = String(elements[start]?.key);
    if (messageIds.has(key) || key.startsWith(worklogKey(""))) rows += 1;
  }
  const first = elements[start]?.key;
  while (start > 0 && elements[start - 1]?.key === `${first}-custom-before`) start -= 1;
  return start;
}

const messageList = (list: HTMLDivElement | null) => {
  const stop = fitBubbles(list);
  return () => stop?.();
};

function MessageRows({ rows, messages, loadOlder }: { rows: ReactElement[]; messages: readonly { id: string }[]; loadOlder: (() => Promise<void>) | undefined }) {
  const [firstKey, setFirstKey] = useState<Key | null>(null);
  const kept = firstKey === null ? -1 : rows.findIndex((row) => row.key === firstKey);
  const messageIds = new Set(messages.map(({ id }) => id));
  const opensAt = useContext(OpensAt);
  const at = kept === -1 && opensAt !== null ? rows.findIndex((row) => row.key === opensAt) : -1;
  const first = kept === -1 ? pageStart(rows, at === -1 ? rows.length : at + 1, messageIds) : kept;
  const firstRowKey = rows[first]?.key ?? null;
  if (kept === -1 && firstRowKey !== firstKey) setFirstKey(firstRowKey);
  const hasOlder = loadOlder !== undefined;
  const rowsRef = useRef({ rows, messageIds, loadOlder });
  rowsRef.current = { rows, messageIds, loadOlder };
  const earlier = useRef<HTMLDivElement>(null);
  const join = () => {
    const now = rowsRef.current;
    if (first > 0) setFirstKey(now.rows[pageStart(now.rows, first, now.messageIds)]?.key ?? null);
    else void now.loadOlder?.();
  };
  useEffect(() => {
    const marker = earlier.current;
    if ((first === 0 && !hasOlder) || marker === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (!entry?.isIntersecting || marker.closest("[inert], [hidden]") !== null) return;
      join();
    });
    observer.observe(marker);
    const shell = marker.closest(".app-shell");
    const uncovered = new MutationObserver(() => {
      observer.disconnect();
      observer.observe(marker);
    });
    if (shell) uncovered.observe(shell, { attributes: true, attributeFilter: ["inert", "hidden"] });
    return () => {
      observer.disconnect();
      uncovered.disconnect();
    };
  }, [first, hasOlder]);

  return (
    <>
      {(first > 0 || hasOlder) && <div ref={earlier} data-chat-earlier aria-hidden />}
      <Presence>{first === 0 && loadOlder && (
        <MotionButton {...presenceMotion} type="button" className="mx-auto block" onClick={() => void loadOlder()}>Load older messages</MotionButton>
      )}</Presence>
      {rows.slice(first).map((row) => <MessageEntranceRow key={row.key} id={String(row.key)}>{row}</MessageEntranceRow>)}
    </>
  );
}

const LoadOlder = createContext<(() => Promise<void>) | undefined>(undefined);

/** A children render prop disables CopilotKit virtualization, whose estimated row heights shift long chats on open. */
function ChatMessages(props: CopilotChatMessageViewProps) {
  const list = useRef<HTMLDivElement | null>(null);
  const attachList = useCallback((element: HTMLDivElement | null) => {
    list.current = element;
    const detach = messageList(element);
    return () => {
      list.current = null;
      detach();
    };
  }, []);
  const runError = useContext(RunError);
  const started = useContext(RunStarted);
  const { running: onServer } = useContext(ServerTurn);
  const ended = useContext(RunEnded);
  const loadOlder = useContext(LoadOlder);
  return (
    <>
      <CopilotChatMessageView {...props} {...props.messages && { messages: props.messages.filter(shows) }} assistantMessage={ASSISTANT_MESSAGE_SLOT} userMessage={USER_MESSAGE} reasoningMessage={REASONING_MESSAGE}>
        {({ messageElements, messages, isRunning: streaming, interruptElement }) => {
          // The Worklog, the Artifact cards and the finished answer settle together at the run's end event, not at its stream close.
          const isRunning = streaming && !ended;
          const last = messages.at(-1);
          return (
            <div ref={attachList} data-copilotkit data-testid="copilot-message-list" className="copilotKitMessages cpk:flex cpk:flex-col">
              <ReplyTurnRunning.Provider value={isRunning}>
                <MessageRows rows={worklogRows(messageElements, messages, isRunning || onServer, { started: isRunning ? started : onServer })} messages={messages} loadOlder={loadOlder} />
              </ReplyTurnRunning.Provider>
              {interruptElement}
              <Presence>{isRunning && last?.role !== "reasoning" && (last?.role ?? "user") === "user" && !started && <motionElement.div {...presenceMotion} className="chat-pending-cursor"><CopilotChatMessageView.Cursor /></motionElement.div>}</Presence>
              {isRunning && last?.role !== "reasoning" && <MomentEnds moment="send-acknowledged" />}
              <ThreadWaiting />

            </div>
          );
        }}
      </CopilotChatMessageView>
      <Presence>{runError !== null && (
        <motionElement.p {...presenceMotion} className="chat-run-error" role="alert">{runError.message}</motionElement.p>
      )}</Presence>
      <Presence>{runError?.question && (
        <motionElement.div {...presenceMotion} className="chat-failed-question">
          <p>Your question</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{runError.question}</p>
        </motionElement.div>
      )}</Presence>
      <Presence>{runError?.retry && (
        <MotionButton {...presenceMotion} type="button" className="chat-turn-retry" onClick={runError.retry}>
          Retry
        </MotionButton>
      )}</Presence>
    </>
  );
}

function ReadOnlyBar({ startNewChat }: { startNewChat: () => void }) {
  return (
    <div data-copilotkit className="cpk:pointer-events-none cpk:relative cpk:z-20" style={{ paddingBottom: "var(--copilotkit-license-banner-offset, 0px)" }}>
      <div className="cpk:max-w-3xl cpk:mx-auto cpk:py-0 cpk:px-4 cpk:@3xl:px-0 cpk:pointer-events-auto">
        <div className="composer-read-only">
          <p>This chat is read-only.</p>
          <Button type="button" variant="primary" onClick={startNewChat}>Start a new chat</Button>
        </div>
      </div>
      <div className="chat-disclaimer cpk:text-center cpk:py-3 cpk:px-4 cpk:max-w-3xl cpk:mx-auto">{UI_CONFIG.disclaimer}</div>
    </div>
  );
}

function ChatInput(props: CopilotChatInputProps) {
  const startNewChat = useContext(ReadOnlyChat);
  return startNewChat === null ? <ComposerInput {...props} /> : <ReadOnlyBar startNewChat={startNewChat} />;
}

const CHAT_INPUT = Object.assign(ChatInput, CopilotChatInput);
const CHAT_MESSAGES = Object.assign(ChatMessages, { Cursor: CopilotChatMessageView.Cursor });

function ChatThread({
  agent,
  threadId,
  accountId,
  turnRunning,
  turnRunsOnServer,
  turnMayRun,
  onMessageSubmitted,
  onTurnStarting,
  onCompose,
  showWelcome,
  isMainChat,
  newChat,
  startNewChat,
  userName,
  composerAccessory,
  models,
  selectedModel,
  isAccountCurrent,
  stopServerTurn,
  savedFailure,
  onOpened,
  openAt,
  loadOlder,
  onOpenRun,
  children,
}: {
  agent: AbstractAgent;
  threadId: string;
    accountId: string | undefined;
  turnRunning: boolean;
  turnRunsOnServer: boolean;
  turnMayRun: () => void;
  onMessageSubmitted: () => void;
  onTurnStarting: (provider: string | undefined) => void;
  /** The user's first input into the composer warms the chat's Sandbox; see `useAgentWarmup`. */
  onCompose: () => void;
    models: ModelList;
  selectedModel: string | undefined;
    isAccountCurrent: () => boolean;
    stopServerTurn: (() => void) | null;
    savedFailure: SavedTurnFailure | null;
  showWelcome: boolean;
  isMainChat: boolean;
  newChat: boolean;
  startNewChat: (() => void) | null;
  userName?: string | undefined;
  composerAccessory?: React.ReactNode;
    onOpened: () => void;
    openAt?: string | null;
    loadOlder?: (() => Promise<void>) | undefined;
    onOpenRun?: (run: ReachedScheduledRun) => void;
  children?: React.ReactNode;
}) {
  const { copilotkit } = useCopilotKit();
  const openingAttempted = useRef(false);
  const firedRef = useRef(false);
  // The Chat Service records a Turn, its title included, before it relays RUN_STARTED: a first message lists the Side
  // Chats again then, or once its run ends without one. A run takes its subscribers when it starts, so this one is
  // already on the agent.
  const listAgain = useRef<(() => void) | null>(null);
  useEffect(() => {
    const again = () => {
      const list = listAgain.current;
      listAgain.current = null;
      list?.();
    };
    const subscription = agent.subscribe({ onRunStartedEvent: again, onRunFinalized: again });
    return () => {
      listAgain.current = null;
      subscription.unsubscribe();
    };
  }, [agent]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [opensAt] = useState(() => (openAt != null && agent.messages.some(({ id }) => id === openAt) ? openAt : null));

  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  useEffect(() => watchOpening(() => wrapperRef.current, () => onOpenedRef.current()),
  // Stryker disable next-line ArrayDeclaration: any constant dependency list checks once, from mount on
  []);
  const [runError, setRunError] = useState<TurnFailure | null>(null);
  const submittedQuestion = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (savedFailure === null) return;
    setRunError((previous) => savedFailure.code === "SESSION_BUSY"
      ? previous?.message === savedFailure.message ? previous : { message: savedFailure.message }
      : couldNotAnswer(savedFailure.message));
  }, [savedFailure]);
  const accountRef = useRef({ models, isAccountCurrent, selectedModel });
  accountRef.current = { models, isAccountCurrent, selectedModel };
  const modelsReady = () => accountRef.current.isAccountCurrent() && accountRef.current.models.loaded;
  const [agentRunning] = useAgentRunning(agent);
  const runEnded = useRunEnded(agent);
  const [openingRunning, setOpeningRunning] = useState(false);
  const running = turnRunning || agentRunning || openingRunning;
  const subscribeRun = useCallback((listener: () => void) => {
    const subscription = agent.subscribe({ onRunStartedEvent: listener, onRunFinalized: listener });
    return () => subscription.unsubscribe();
  }, [agent]);
  const started = useSyncExternalStore(subscribeRun, () => runStarted(agent), () => false);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    const selected = models.loaded ? models.models.find(({ key }) => key === selectedModel) : undefined;
    if (!isMainChat || openingAttempted.current || !showWelcome || running || savedFailure !== null ||
        agent.messages.length !== 0 || !online || !isAccountCurrent() || !models.loaded ||
        models.accountId !== accountId || selected === undefined) return;
    openingAttempted.current = true;
    onTurnStarting(selected.provider);
    runningRef.current = true;
    setOpeningRunning(true);
    const firstName = userName?.split(" ")[0];
    void (async () => {
      try {
        await copilotkit.runAgent({ agent, forwardedProps: { opening: true, ...(firstName ? { openingFirstName: firstName } : {}) } });
      } catch (error) {
        setRunError(couldNotAnswer(error instanceof Error ? error.message : String(error)));
      } finally {
        setOpeningRunning(false);
      }
    })();
  }, [agent, accountId, isMainChat, showWelcome, running, savedFailure, online, models, selectedModel, userName, isAccountCurrent, copilotkit, onTurnStarting]);
  const composerSubmit = useRef<Submit | null>(null);
  const refreshSideChatsOnce = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    onMessageSubmitted();
    listAgain.current = onMessageSubmitted;
  };
  const submitTurn = (message: string, submit: Submit, retry: () => void = () => submitTurn(message, submit)) => {
    const sent = runningRef.current ? steer(message) : startTurn(message, submit, retry);
    if (sent && message.trim()) refreshSideChatsOnce();
    return sent;
  };
  const startTurn = (message: string, submit: Submit, retry: () => void) => {
    if (!modelsReady()) {
      const { models: accountModels } = accountRef.current;
      setRunError(
        !accountModels.loaded && accountModels.error !== null
          ? { message: `${accountModels.error}. Reload the page to send a message.`, question: message }
          : { message: "Your models are still loading. Send it again once they have.", retry },
      );
      return false;
    }
    if (!navigator.onLine) {
      setRunError({ message: `Couldn't reach ${UI_CONFIG.title}. Check your connection.`, retry });
      return false;
    }
    const { models: accountModels, selectedModel: currentModel } = accountRef.current;
    onTurnStarting(accountModels.loaded ? accountModels.models.find(({ key }) => key === currentModel)?.provider : undefined);
    setRunError(null);
    startMoment("send-acknowledged");
    submittedQuestion.current = message;
    void submit(message);
    return true;
  };
  const showBusyRefusal = (error: Error) => {
    const parsed = busyRefusal.safeParse("payload" in error ? error.payload : undefined);
    if (!("status" in error) || error.status !== 409 || !parsed.success) return false;
    const question = submittedQuestion.current;
    setRunError({ message: parsed.data.detail, question, ...(question === undefined ? {} : { retry: () => {
      const submit = composerSubmit.current;
      if (submit === null) return;
      const last = agent.messages.at(-1);
      submitTurn(question, last?.role === "user" && last.content === question ? () => { void copilotkit.runAgent({ agent }); } : submit);
    } }) });
    return true;
  };
  const steeringDrop = useContext(SteeringDrop);
  const { steer, drop: dropSteering, waiting, withdraw, sendNow } = useSteering({
    agent, accountId, threadId, running, ready: online && modelsReady(), serviceUrl: CHAT_SERVICE_URL,
    submit: (text) => composerSubmit.current !== null && submitTurn(text, composerSubmit.current),
    failed: (message) => setRunError({ message }),
    heldElsewhere: turnMayRun,
  });
  if (steeringDrop === null) throw new Error("A chat's steering needs the ChatSurface that holds it");
  steeringDrop.current = dropSteering;
  useEffect(() => {
    const subscription = agent.subscribe({
      onNewMessage: ({ message }) => {
        if (message.role === "user") setRunError(null);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const onComposeRef = useRef(onCompose);
  onComposeRef.current = onCompose;
  const compose = useCallback(() => onComposeRef.current(), []);
  const attachedFiles = useComposerFiles(agentFiles, accountId, compose);
  const fileDrop = useFileDrop(attachedFiles.add);

  const composerStop = useRef<(() => void) | null>(null);
  const waitingComposer = useRef<LentComposer | null>(null);


  return (
    <div className="chat-wrapper" ref={wrapperRef} onKeyDown={stopOnEscapeNoMenuTook(composerStop)} {...fileDrop.handlers}>
      <FileDropOverlay open={fileDrop.over} />
      <Presence>{showWelcome && !running && !openingAttempted.current && <motionElement.div {...presenceMotion} className="chat-welcome"><WelcomeScreen userName={userName} /></motionElement.div>}</Presence>
      <ToolCallRenderer agent={agent} />
      <SubmitTurn.Provider value={submitTurn}>
      <ComposerSubmit.Provider value={composerSubmit}>
      <ComposerStop.Provider value={composerStop}>
      <ServerTurn.Provider value={{ running: turnRunsOnServer, stop: stopServerTurn }}>
      <ComposerAccessory.Provider value={composerAccessory}>
      <ComposerPicker.Provider value={{ picker: children, autoFocus: newChat && showWelcome }}>
      <SteeringWaiting.Provider value={{ waiting, withdraw, sendNow }}>
      <WaitingComposer.Provider value={waitingComposer}>
      <Compose.Provider value={compose}>
      <AttachedFiles.Provider value={attachedFiles}>
      <OpenScheduledRun.Provider value={onOpenRun ?? null}>
      <OpensAt.Provider value={opensAt}>
      <LoadOlder.Provider value={loadOlder}>
      <ReadOnlyChat.Provider value={startNewChat}>
        <RunError.Provider value={runError}>
        <RunStarted.Provider value={started}>
        <RunEnded.Provider value={runEnded}>
          <CopilotChat
            agentId={AGENT_ID}
            threadId={threadId}
            labels={{ chatInputPlaceholder: "Ask anything", chatDisclaimerText: UI_CONFIG.disclaimer, chatInputToolbarAddButtonLabel: "Add photos & files" }}
            className="chat-full-height"
            messageView={CHAT_MESSAGES}
            input={CHAT_INPUT}
            scrollView={ConversationScrollView}
            onError={(event) => {
              const error = "error" in event ? event.error : new Error("Chat content failed to load");
              if (error.name === "AbortError") return;
              if ((error as Error & { code?: unknown }).code === "TURN_STOPPED" && stoppedHere(agent)) return;
              // A failed request leaves open whether the service accepted the Turn.
              const status = (error as Error & { status?: unknown }).status;
              const failed = "code" in event && event.code.startsWith("agent_run_failed");
              if (failed && showBusyRefusal(error)) return;
              const unconfirmed = failed && /^5\d\d$/.test(String(status));
              setRunError({
                ...(unconfirmed ? { message: `${UI_CONFIG.title} couldn't confirm your message was received. Check this chat before sending it again.` } : couldNotAnswer(error.message)),
                ...((unconfirmed || (failed && error instanceof TypeError)) && { question: submittedQuestion.current }),
              });
            }}
          />
        </RunEnded.Provider>
        </RunStarted.Provider>
        </RunError.Provider>
      </ReadOnlyChat.Provider>
      </LoadOlder.Provider>
      </OpensAt.Provider>
      </OpenScheduledRun.Provider>
      </AttachedFiles.Provider>
      </Compose.Provider>
      </WaitingComposer.Provider>
      </SteeringWaiting.Provider>
      </ComposerPicker.Provider>
      </ComposerAccessory.Provider>
      </ServerTurn.Provider>
      </ComposerStop.Provider>
      </ComposerSubmit.Provider>
      </SubmitTurn.Provider>
    </div>
  );
}

export interface ChatStop {
  chatId: string;
  stop: () => void;
}

function ComputerStop({ chatId, stopRef }: { chatId: string; stopRef: Ref<ChatStop> | undefined }) {
  const { copilotkit } = useCopilotKit();
  const dropSteering = useDropSteering();
  useImperativeHandle(stopRef, () => ({ chatId, stop: () => {
    dropSteering();
    const agent = copilotkit.getAgent(AGENT_ID);
    if (agent) copilotkit.stopAgent({ agent });
  } }), [chatId, copilotkit, dropSteering]);
  return null;
}

export default function ChatSurface({ children, chatId, stopRef, entrances, ...props }: Omit<ComponentProps<typeof CopilotKit>, "children"> & {
  children: (Thread: typeof ChatThread) => ReactNode;
  chatId: string;
  stopRef?: Ref<ChatStop>;
  entrances: MessageEntrances;
}) {
  const steeringDrop = useRef<(() => void) | null>(null);
  return (
    <CopilotKit {...props}>
      {/* A reply's first chart draws from plotly.js the browser fetched while the chat sat idle. */}
      <PlotlyPrefetch />
      <SteeringDrop.Provider value={steeringDrop}>
        <ComputerStop chatId={chatId} stopRef={stopRef} />
        <MessageEntranceHistory.Provider value={entrances}>{children(ChatThread)}</MessageEntranceHistory.Provider>
      </SteeringDrop.Provider>
    </CopilotKit>
  );
}
