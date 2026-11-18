"use client";

import { Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "motion/react";

import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Key, type ReactElement, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
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
import { useComposerSizing } from "./composer-layout-height";
import { useComposerOpen } from "./composer-open";
import { keepArtifactReading } from "./artifact-reading";
import { NATIVE_READING, ReadingState } from "./native-reading";
import { keepInPlace, holdReading, rowRead, useRowsLandOnce, viewTop, type ReadRow } from "./reading-hold";
import { OPENING_MS, scrollParent, watchOpening } from "./chat-opening";
import { useScrollUpClosesKeyboard } from "./phone-keyboard-dismiss";
import { useInitialStick, useRotationReading } from "./rotation-reading";
import { useIsPhone } from "./phone-query";
import { useStickToBottom, type StickToBottomInstance } from "use-stick-to-bottom";
import { webUiPlugin } from "@cartridge-ui";
import { AssistantMessage, USER_MESSAGE } from "./reading-message";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { Button } from "@/components/ui/button";
import { cn, zoomOf } from "@/lib/utils";
import { ComposerFilePicker, attachPastedImages, messageWithFiles, useComposerFiles, type ComposerFiles } from "./composer-files";
import { FileDropOverlay, addMenuSlot, useFileDrop } from "./composer-attach";
import { ThoughtStep, ToolStep, worklogRows } from "./worklog";
import { showsProposalCard } from "./worklog-tools";
import { fitBubbles } from "./bubble-width";
import { prefetchPlotly } from "../components/plotly-bundle";
import { keepLateBoxes } from "./late-boxes";
import { shows, useSteering, type PendingMessage, type Withdrawal } from "./steering";
import { SHOWS_WAITING_STEERING, WaitingMessages } from "./waiting-steering";
import { MessageEntranceRow, MessageEntranceHistory, type MessageEntrances } from "./message-entrance";
import { useAgentRunning } from "./agent-running";

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

/** CopilotChatInput's send button becomes an unnamed, icon-only Stop while the agent runs. */
function sendButtonSlot(mode: CopilotChatInputProps["mode"], isRunning: boolean, held: boolean, sendFiles?: () => void) {
  if (mode === "transcribe") return {};
  return { sendButton: { "aria-label": isRunning ? "Stop" : "Send", ...(!isRunning && sendFiles ? { disabled: held, onClick: sendFiles } : held && !isRunning ? { disabled: true } : {}) } };
}

function useComposerKeyboard() {
  return useIsPhone() ? { keyboardHeight: 0, bottomAnchored: false } : {};
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
  if (!SHOWS_WAITING_STEERING || !steering || !composer) return null;
  const sendNow = async (id: string) => {
    const outcome = await steering.sendNow(id);
    if (outcome === "withdrawn") composer.current?.stopTurn?.();
    return outcome;
  };
  return <WaitingMessages waiting={steering.waiting} withdraw={steering.withdraw} sendNow={sendNow} onEdit={({ content }) => composer.current?.edit(content)} />;
}

function ComposerInput(props: CopilotChatInputProps) {
  const keyboard = useComposerKeyboard();
  const accessory = useContext(ComposerAccessory);
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
  const fileOnly = !((props.value ?? draft).trim()) && (attached?.files.length ?? 0) > 0;
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
  text.current = props.value ?? draft;
  const onChange = (value: string) => { setDraft(value); props.onChange?.(value); compose(); };
  useLendComposer(text, onChange, stopTurn);
  return (
    <>
      {attached && <ComposerFilePicker attached={attached} picker={picker} />}
      <Presence>{accessory && (
        <motionElement.div {...presenceMotion} className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:sm:px-0">
          <div className="composer-accessory">{accessory}</div>
        </motionElement.div>
      )}</Presence>
      <CopilotChatInput
        {...props}
        {...keyboard}
        className={cn(props.className, attached && "composer-can-attach")}
        isRunning={isRunning}
        onChange={onChange}
        disclaimer="chat-disclaimer"
        {...addMenuSlot(attached, picker)}
        textArea={{ onKeyDownCapture: holdEnter(held, isRunning, sendFiles), ...(attached ? { onPaste: attachPastedImages(attached.add) } : {}) }}
        {...(stop ? { onStop: stop } : {})}
        {...(submit && submitTurn ? { onSubmitMessage: (message: string) => sendWithFiles(message, attachedRef, submitTurn, submit) } : {})}
        {...sendButtonSlot(props.mode, isRunning, held, sendFiles)}
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

const OpensAt = createContext<string | null>(null);

const couldNotAnswer = (message: string): TurnFailure => ({ message: `The agent could not answer: ${message}` });
const busyRefusal = z.object({ code: z.literal("SESSION_BUSY"), detail: z.string() });

function eventsOf(scroller: Element): EventTarget {
  return scroller === document.scrollingElement ? window : scroller;
}

// Element.scrollIntoView is one-shot; an opening history-row target must survive late reply and composer layout.
function holdAtRow(wrapper: Element, id: string): () => void {
  const started = performance.now();
  let frame = 0;
  const hold = (now: number) => {
    const row = wrapper.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    const scroller = row && scrollParent(row);
    if (row && scroller) {
      const header = wrapper.closest(".app-shell")?.querySelector(".chat-header")?.getBoundingClientRect().bottom ?? 0;
      scroller.scrollTop += (row.getBoundingClientRect().top - Math.max(viewTop(scroller), header)) / zoomOf(scroller);
    }
    if (now - started < OPENING_MS) frame = requestAnimationFrame(hold);
  };
  const release = () => {
    cancelAnimationFrame(frame);
    for (const type of USER_SCROLLS) window.removeEventListener(type, release, true);
  };
  for (const type of USER_SCROLLS) window.addEventListener(type, release, { capture: true, passive: true });
  frame = requestAnimationFrame(hold);
  return release;
}
const USER_SCROLLS = ["wheel", "touchstart", "pointerdown", "keydown"];

const STICK_INSTANTLY = { initial: "instant", resize: "instant" } as const;

function ScrollButton({ stick, inputHeight, resizing, follow }: { stick: StickToBottomInstance; inputHeight: number; resizing: boolean; follow: () => void }) {
  const setReading = useContext(ReadingState)?.setActive;
  const { isAtBottom } = stick;
  useLayoutEffect(() => {
    if (NATIVE_READING) setReading?.(!isAtBottom);
  }, [setReading, isAtBottom]);
  const hidden = isAtBottom || resizing;
  return (
    <div className="chat-page-jump" data-shown={hidden ? undefined : ""} inert={hidden} style={{ bottom: inputHeight + 16 }}>
      <CopilotChatView.ScrollToBottomButton onClick={() => { follow(); void stick.scrollToBottom({ animation: "smooth", ignoreEscapes: true }); }} />
    </div>
  );
}

type ScrollControlProps = { inputContainerHeight: number; isResizing: boolean; contentRef: RefObject<HTMLDivElement | null>; opened: RefObject<boolean>; followsLatest: () => boolean; follow: () => void };

const NO_BUTTON = () => null;

function DocumentStick({ inputContainerHeight, isResizing, contentRef, opened, followsLatest, follow }: ScrollControlProps) {
  const opensAt = useContext(OpensAt);
  const initial = useInitialStick(opened, followsLatest);
  const stick = useStickToBottom({ ...STICK_INSTANTLY, initial: initial && opensAt === null ? "instant" : false });
  const { scrollRef, scrollToBottom, contentRef: stickContent } = stick;
  useScrollUpClosesKeyboard();
  useLayoutEffect(() => {
    if (!contentRef.current) throw new Error("The phone chat's page stick needs the chat's content before it");
    stickContent(contentRef.current);
    const root = document.documentElement;
    scrollRef(root);
    // Document scroll events target Document; the library accepts events targeted at its scroll element.
    const scrolled = (event: Event) => {
      if (event.target === document) root.dispatchEvent(new Event("scroll"));
    };
    document.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      document.removeEventListener("scroll", scrolled);
      scrollRef(null);
      stickContent(null);
    };
  }, [scrollRef, stickContent, contentRef]);
  useEffect(() => {
    const resized = () => { void scrollToBottom({ animation: "instant", preserveScrollPosition: true }); };
    window.addEventListener("resize", resized);
    window.visualViewport?.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("resize", resized);
      window.visualViewport?.removeEventListener("resize", resized);
    };
  }, [scrollToBottom]);
  return <ScrollButton stick={stick} inputHeight={inputContainerHeight + 16} resizing={isResizing} follow={follow} />;
}

function ChatScrollView(props: ComponentProps<typeof CopilotChatView.ScrollView>) {
  const [reading, setReading] = useState(false);
  const readingState = useMemo(() => ({ active: reading, setActive: setReading }), [reading]);
  const opensAt = useContext(OpensAt);
  const phone = useIsPhone();
  const { attach, content, opened, followsLatest, follow, instance, options } = useRotationReading(phone, opensAt === null);
  const controlProps = { inputContainerHeight: props.inputContainerHeight ?? 0, isResizing: props.isResizing ?? false, contentRef: content, opened, followsLatest, follow };
  return (
    <ReadingState.Provider value={readingState}>
    <CopilotChatView.ScrollView
      {...props}
      {...options}
      instance={instance}
      className="chat-scroll-view"
      scrollToBottomButton={NO_BUTTON}
      feather={{ style: { display: "contents" }, children: phone ? <DocumentStick {...controlProps} /> : <ScrollButton stick={instance} inputHeight={controlProps.inputContainerHeight} resizing={controlProps.isResizing} follow={follow} /> }}
    >
      <div ref={attach} data-reading-active={NATIVE_READING && reading ? "" : undefined}>{props.children}</div>
    </CopilotChatView.ScrollView>
    </ReadingState.Provider>
  );
}

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
    if (messageIds.has(String(elements[start]?.key))) rows += 1;
  }
  const first = elements[start]?.key;
  while (start > 0 && elements[start - 1]?.key === `${first}-custom-before`) start -= 1;
  return start;
}

const messageList = (list: HTMLDivElement | null) => {
  const stops = [keepArtifactReading(list), fitBubbles(list), keepLateBoxes(list)];
  return () => stops.forEach((stop) => stop?.());
};

function MessageRows({ rows, messages, list }: { rows: ReactElement[]; messages: readonly { id: string }[]; list: RefObject<HTMLDivElement | null> }) {
  const [firstKey, setFirstKey] = useState<Key | null>(null);
  const kept = firstKey === null ? -1 : rows.findIndex((row) => row.key === firstKey);
  const messageIds = new Set(messages.map(({ id }) => id));
  const opensAt = useContext(OpensAt);
  const at = kept === -1 && opensAt !== null ? rows.findIndex((row) => row.key === opensAt) : -1;
  const first = kept === -1 ? pageStart(rows, at === -1 ? rows.length : at + 1, messageIds) : kept;
  const firstRowKey = rows[first]?.key ?? null;
  if (kept === -1 && firstRowKey !== firstKey) setFirstKey(firstRowKey);

  const rowsRef = useRef({ rows, messageIds });
  rowsRef.current = { rows, messageIds };
  const earlier = useRef<HTMLDivElement>(null);
  const reading = useRef<ReadRow | null>(null);
  const join = () => {
    const now = rowsRef.current;
    setFirstKey(now.rows[pageStart(now.rows, first, now.messageIds)]?.key ?? null);
  };
  useRowsLandOnce(list, earlier, opensAt === null, first, join);
  useEffect(() => {
    const marker = earlier.current;
    if (first === 0 || marker === null) return undefined;
    let reported = false;
    // A callback can carry several of the marker's changes, oldest first: on a loaded phone one held its going out of
    // view as a page joined and its coming back, and acting on the first left earlier history unloaded for good.
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      const atStart = !reported;
      reported = true;
      if (!entry?.isIntersecting || marker.closest("[inert], [hidden]") !== null) return;
      const scroller = scrollParent(marker);
      const list = marker.parentElement;
      if (!(atStart && reading.current?.row.isConnected)) reading.current = scroller && list && rowRead(list, scroller);
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
  }, [first]);
  useLayoutEffect(() => {
    const read = reading.current;
    const list = earlier.current?.parentElement ?? read?.row.parentElement;
    if (read === null || list == null) return undefined;
    if (NATIVE_READING) {
      // Native anchoring does not land prepended history at scrollTop=0; retain the existing one-time pin.
      keepInPlace(read);
      return undefined;
    }
    return holdReading(read, list, eventsOf(read.scroller));
  }, [first]);

  return (
    <>
      {first > 0 && <div ref={earlier} data-chat-earlier aria-hidden />}
      {rows.slice(first).map((row) => <MessageEntranceRow key={row.key} id={String(row.key)}>{row}</MessageEntranceRow>)}
    </>
  );
}

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
  return (
    <>
      <CopilotChatMessageView {...props} {...props.messages && { messages: props.messages.filter(shows) }} assistantMessage={ASSISTANT_MESSAGE_SLOT} userMessage={USER_MESSAGE} reasoningMessage={REASONING_MESSAGE}>
        {({ messageElements, messages, isRunning, interruptElement }) => {
          const last = messages.at(-1);
          return (
            <div ref={attachList} data-copilotkit data-testid="copilot-message-list" className="copilotKitMessages cpk:flex cpk:flex-col">
              <ReplyTurnRunning.Provider value={isRunning}>
                <MessageRows rows={worklogRows(messageElements, messages, isRunning || onServer, { started: isRunning ? started : onServer })} messages={messages} list={list} />
              </ReplyTurnRunning.Provider>
              {interruptElement}
              <Presence>{isRunning && last?.role !== "reasoning" && (last?.role ?? "user") === "user" && !started && <motionElement.div {...presenceMotion} className="cpk:mt-2"><CopilotChatMessageView.Cursor /></motionElement.div>}</Presence>
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
    onOpenRun?: (run: ReachedScheduledRun) => void;
  children?: React.ReactNode;
}) {
  const { copilotkit } = useCopilotKit();
  const openingAttempted = useRef(false);
  const firedRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), []);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useComposerSizing(wrapperRef);
  useComposerOpen(wrapperRef);
  const [opensAt] = useState(() => (openAt != null && agent.messages.some(({ id }) => id === openAt) ? openAt : null));
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (opensAt === null || wrapper === null) return undefined;
    return holdAtRow(wrapper, opensAt);
  },
  // Stryker disable next-line ArrayDeclaration: a chat opens at its message once, as it mounts
  []);

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
    refreshTimerRef.current = window.setTimeout(onMessageSubmitted, 1000);
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

  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const picker = pickerRef.current;
    const wrapper = wrapperRef.current;
    if (!picker || !wrapper) return;

    const transplant = () => {
      const sendCell = wrapper.querySelector<HTMLElement>('[class*="cpk:col-start-3"]');
      if (sendCell && !sendCell.contains(picker)) {
        sendCell.insertBefore(picker, sendCell.firstChild);
        picker.style.visibility = "";
        picker.style.position = "";
        sendCell.closest(".copilotKitInput")?.classList.add("picker-ready");
        if (newChat && showWelcome) wrapper.querySelector('textarea')?.focus();
        // Stryker disable next-line BooleanLiteral: a needless observer finds the picker placed and never moves it
        return true;
      }
      return false;
    };

    if (transplant()) return;

    const observer = new MutationObserver(() => {
      if (transplant()) observer.disconnect();
    });
    observer.observe(wrapper, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      wrapper.appendChild(picker);
    };
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list places the picker once, on mount
  []);

  return (
    <div className="chat-wrapper" data-native-reading={NATIVE_READING ? "" : undefined} ref={wrapperRef} onKeyDown={stopOnEscapeNoMenuTook(composerStop)} {...fileDrop.handlers}>
      <FileDropOverlay open={fileDrop.over} />
      <Presence>{showWelcome && !running && !openingAttempted.current && <motionElement.div {...presenceMotion} className="chat-welcome"><WelcomeScreen userName={userName} /></motionElement.div>}</Presence>
      <ToolCallRenderer agent={agent} />
      <SubmitTurn.Provider value={submitTurn}>
      <ComposerSubmit.Provider value={composerSubmit}>
      <ComposerStop.Provider value={composerStop}>
      <ServerTurn.Provider value={{ running: turnRunsOnServer, stop: stopServerTurn }}>
      <ComposerAccessory.Provider value={composerAccessory}>
      <SteeringWaiting.Provider value={{ waiting, withdraw, sendNow }}>
      <WaitingComposer.Provider value={waitingComposer}>
      <Compose.Provider value={compose}>
      <AttachedFiles.Provider value={attachedFiles}>
      <OpenScheduledRun.Provider value={onOpenRun ?? null}>
      <OpensAt.Provider value={opensAt}>
      <ReadOnlyChat.Provider value={startNewChat}>
        <RunError.Provider value={runError}>
        <RunStarted.Provider value={started}>
          <CopilotChat
            agentId={AGENT_ID}
            threadId={threadId}
            labels={{ chatInputPlaceholder: "Ask anything", chatDisclaimerText: UI_CONFIG.disclaimer, chatInputToolbarAddButtonLabel: "Add photos & files" }}
            className="chat-full-height"
            messageView={CHAT_MESSAGES}
            input={CHAT_INPUT}
            scrollView={ChatScrollView}
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
        </RunStarted.Provider>
        </RunError.Provider>
      </ReadOnlyChat.Provider>
      </OpensAt.Provider>
      </OpenScheduledRun.Provider>
      </AttachedFiles.Provider>
      </Compose.Provider>
      </WaitingComposer.Provider>
      </SteeringWaiting.Provider>
      </ComposerAccessory.Provider>
      </ServerTurn.Provider>
      </ComposerStop.Provider>
      </ComposerSubmit.Provider>
      </SubmitTurn.Provider>
      <div ref={pickerRef} style={{ position: "absolute", visibility: "hidden" }}>{children}</div>
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
  // A reply's first chart draws from plotly.js the browser fetched while the chat sat idle.
  useEffect(() => prefetchPlotly(), []);
  return (
    <CopilotKit {...props}>
      <SteeringDrop.Provider value={steeringDrop}>
        <ComputerStop chatId={chatId} stopRef={stopRef} />
        <MessageEntranceHistory.Provider value={entrances}>{children(ChatThread)}</MessageEntranceHistory.Provider>
      </SteeringDrop.Provider>
    </CopilotKit>
  );
}
