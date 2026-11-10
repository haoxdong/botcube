"use client";

import { Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "framer-motion";

import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type Key, type ReactElement, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
import { CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  type CopilotChatReasoningMessage,
  CopilotChatView,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
} from "@copilotkit/react-core/v2";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import type { AbstractAgent } from "@ag-ui/client";
import { holdEnter, stopOnEscapeNoMenuTook } from "./composer-keys";
import { runStarted, stoppedHere, toolCancellationStore, type SavedTurnFailure } from "./conversations";
import { endMoment, startMoment, type Moment } from "./latency";
import type { ModelList } from "./model-selection";
import { agentFiles } from "./agent-files";
import { ScheduledTaskProposalCard, type ScheduledTaskProposal } from "./scheduled-tasks";
import { OpenScheduledRun, ScheduledRunCard, scheduledRunOf, type ReachedScheduledRun } from "./scheduled-run-card";
import MarkdownRenderer from "./markdown-renderer";
import { ReplyTurnRunning } from "./reply-turn";
import { useComposerSizing } from "./composer-layout-height";
import { useComposerOpen } from "./composer-open";
import { holdReading, rowRead, useRowsLandOnce, viewTop, type ReadRow } from "./reading-hold";
import { messagesScroller, OPENING_MS, scrollParent, watchOpening } from "./chat-opening";
import { useScrollUpClosesKeyboard } from "./phone-keyboard-dismiss";
import { AT_BOTTOM_PX, useInitialStick, useRotationReading } from "./rotation-reading";
import { useIsPhone } from "./phone-query";
import { useStickToBottom, type StickToBottomInstance } from "use-stick-to-bottom";
import { webUiPlugin } from "@cartridge-ui";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { Button } from "@/components/ui/button";
import { cn, zoomOf } from "@/lib/utils";
import { ComposerFilePicker, SentFileCards, attachPastedImages, messageWithFiles, sentFilesOf, useComposerFiles, type ComposerFiles } from "./composer-files";
import { FileDropOverlay, addMenuSlot, useFileDrop } from "./composer-attach";
import { ThoughtStep, ToolStep, Worklog, worklogRows } from "./worklog";
import { USER_MESSAGE_CLASS, fitBubbles } from "./bubble-width";
import { prefetchPlotly } from "../components/plotly-bundle";
import { keepLateBoxes } from "./late-boxes";
import { containRows } from "./row-containment";
import { markBubbleEnds } from "./bubble-ends";
import { useSteering } from "./steering";
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
        !(typeof result === "string" && result.startsWith("Error invoking tool 'propose_scheduled_task'"))) {
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
        onChange={(value: string) => { setDraft(value); props.onChange?.(value); compose(); }}
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

const JUMP_SETTLE_FRAMES = 3;

function eventsOf(scroller: Element): EventTarget {
  return scroller === document.scrollingElement ? window : scroller;
}

function holdAtBottom(scroller: Element) {
  let still = 0;
  const events = eventsOf(scroller);
  const hold = () => {
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    if (scroller.scrollTop < bottom) {
      scroller.scrollTop = bottom;
      still = 0;
    }
  };
  const release = () => {
    events.removeEventListener("scroll", hold);
    events.removeEventListener("pointerdown", release);
  };
  const frame = () => {
    still += 1;
    if (still < JUMP_SETTLE_FRAMES) requestAnimationFrame(frame);
    else release();
  };
  events.addEventListener("scroll", hold);
  events.addEventListener("pointerdown", release);
  hold();
  requestAnimationFrame(frame);
}

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

/** CopilotKit's spring mistakes momentum for a new user scroll and cancels the jump. */
function JumpToBottom({ onClick, follow, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { follow: () => void }) {
  return (
    <CopilotChatView.ScrollToBottomButton
      {...props}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        const wrapper = event.currentTarget.closest<HTMLElement>(".chat-wrapper");
        const scroller = messagesScroller(wrapper);
        if (!wrapper || !scroller) {
          onClick?.(event);
          return;
        }
        if (wrapper.dataset.jumping !== undefined) return;
        wrapper.dataset.jumping = "";
        const duration = getComputedStyle(wrapper).getPropertyValue("--motion-quick").trim();
        const milliseconds = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) || 0;
        window.setTimeout(() => {
          follow();
          const reveal = () => requestAnimationFrame(() => delete wrapper.dataset.jumping);
          holdAtBottom(scroller);
          reveal();
          onClick?.(event);
        }, milliseconds);
      }}
    />
  );
}

const STICK_INSTANTLY = { initial: "instant", resize: "instant" } as const;

function ScrollButton({ stick, inputHeight, resizing, follow }: { stick: StickToBottomInstance; inputHeight: number; resizing: boolean; follow: () => void }) {
  const hidden = stick.isAtBottom || resizing;
  return (
    <div className="chat-page-jump" data-shown={hidden ? undefined : ""} inert={hidden} style={{ bottom: inputHeight + 16 }}>
      <JumpToBottom follow={follow} />
    </div>
  );
}

type ScrollControlProps = { inputContainerHeight: number; isResizing: boolean; contentRef: RefObject<HTMLDivElement | null>; opened: RefObject<boolean>; followsLatest: () => boolean; follow: () => void };

/** CopilotKit unmounts its jump control at the bottom in one frame. */
function DesktopJump({ inputContainerHeight, isResizing, follow }: ScrollControlProps) {
  const place = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    // CopilotKit renders its feather slot right after its StickToBottom content, the chat's scroller.
    const scroller = place.current?.parentElement?.previousElementSibling;
    if (!scroller) throw new Error("The desktop jump control needs the chat's scroller before it");
    const measure = () => setAtBottom(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= AT_BOTTOM_PX);
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const resized = new ResizeObserver(measure);
    for (const box of [scroller, ...scroller.children]) resized.observe(box);
    return () => {
      scroller.removeEventListener("scroll", measure);
      resized.disconnect();
    };
  }, []);
  const hidden = atBottom || isResizing;
  return (
    <div ref={place} className="chat-page-jump" data-shown={hidden ? undefined : ""} inert={hidden} style={{ bottom: `${inputContainerHeight + 16}px` }}>
      <JumpToBottom follow={follow} />
    </div>
  );
}

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
  const opensAt = useContext(OpensAt);
  const phone = useIsPhone();
  const { attach, content, opened, followsLatest, follow, instance, options } = useRotationReading(phone, opensAt === null);
  const controlProps = { inputContainerHeight: props.inputContainerHeight ?? 0, isResizing: props.isResizing ?? false, contentRef: content, opened, followsLatest, follow };
  return (
    <CopilotChatView.ScrollView
      {...props}
      {...options}
      instance={instance}
      className="chat-scroll-view"
      scrollToBottomButton={NO_BUTTON}
      feather={{ style: { display: "contents" }, children: phone ? <DocumentStick {...controlProps} /> : <DesktopJump {...controlProps} /> }}
    >
      <div ref={attach}>{props.children}</div>
    </CopilotChatView.ScrollView>
  );
}

const MARKDOWN_RENDERER = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;

function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const run = scheduledRunOf(props.message);
  if (run !== null) return <div data-message-id={props.message.id}><ScheduledRunCard run={run}><MarkdownRenderer content={run.text} /></ScheduledRunCard></div>;
  return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN_RENDERER} />;
}

/** The slot types its component with CopilotKit's sub-components, which it never reads, only renders. */
const ASSISTANT_MESSAGE_SLOT = AssistantMessage as typeof CopilotChatAssistantMessage;

/** CopilotKit types slots with its statics but only calls the component. */
const REASONING_MESSAGE = ThoughtStep as unknown as typeof CopilotChatReasoningMessage;

function SentMessage({ content }: { content: string }) {
  const { text, paths } = sentFilesOf(content);
  return (
    <>
      <SentFileCards paths={paths} fileUrl={agentFiles.url} />
      <Presence>{text && <motionElement.div {...presenceMotion} className={USER_MESSAGE_CLASS}>{text}</motionElement.div>}</Presence>
    </>
  );
}

const USER_MESSAGE = { messageRenderer: SentMessage };

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

function finishEntrances(list: Element) {
  for (const animation of list.getAnimations({ subtree: true })) {
    if (animation instanceof CSSAnimation && animation.animationName === "messageIn") animation.finish();
  }
}

const messageList = (list: HTMLDivElement | null) => {
  if (list !== null) finishEntrances(list);
  const stops = [fitBubbles(list), keepLateBoxes(list), containRows(list), markBubbleEnds(list)];
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
  const joined = useRef(false);
  useLayoutEffect(() => {
    const read = reading.current;
    const list = earlier.current?.parentElement ?? read?.row.parentElement;
    if (joined.current && list != null) finishEntrances(list);
    joined.current = true;
    if (read === null || list == null) return undefined;
    return holdReading(read, list, eventsOf(read.scroller));
  }, [first]);

  return (
    <>
      {first > 0 && <div ref={earlier} data-chat-earlier aria-hidden />}
      {rows.slice(first)}
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
      <CopilotChatMessageView {...props} assistantMessage={ASSISTANT_MESSAGE_SLOT} userMessage={USER_MESSAGE} reasoningMessage={REASONING_MESSAGE}>
        {({ messageElements, messages, isRunning, interruptElement }) => {
          const last = messages.at(-1);
          return (
            <div ref={attachList} data-copilotkit data-testid="copilot-message-list" className="copilotKitMessages cpk:flex cpk:flex-col">
              <ReplyTurnRunning.Provider value={isRunning}>
                <MessageRows rows={worklogRows(messageElements, messages, isRunning || onServer)} messages={messages} list={list} />
              </ReplyTurnRunning.Provider>
              <Presence>{(isRunning ? started : onServer) && last?.role === "user" && <motionElement.div {...presenceMotion} key={last.id}><Worklog id={last.id} running asked={last.id} /></motionElement.div>}</Presence>
              {interruptElement}
              <Presence>{isRunning && last?.role !== "reasoning" && (last?.role ?? "user") === "user" && !started && <motionElement.div {...presenceMotion} className="cpk:mt-2"><CopilotChatMessageView.Cursor /></motionElement.div>}</Presence>
              {isRunning && last?.role !== "reasoning" && <MomentEnds moment="send-acknowledged" />}

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
  temporary,
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
  /** A temporary chat has no Files and no steering: both need the account. */
  temporary: boolean;
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
    if (savedFailure !== null) setRunError(couldNotAnswer(savedFailure.message));
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
    if (runningRef.current && temporary) {
      setRunError({ message: "Wait for this answer to finish: a temporary chat takes your next message after it." });
      return false;
    }
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
  const steeringDrop = useContext(SteeringDrop);
  const { steer, drop: dropSteering } = useSteering({
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
    <div className="chat-wrapper" ref={wrapperRef} onKeyDown={stopOnEscapeNoMenuTook(composerStop)} {...(temporary ? {} : fileDrop.handlers)}>
      <FileDropOverlay open={fileDrop.over} />
      <Presence>{showWelcome && !running && !openingAttempted.current && <motionElement.div {...presenceMotion} className="chat-welcome"><WelcomeScreen userName={userName} /></motionElement.div>}</Presence>
      <ToolCallRenderer agent={agent} />
      <SubmitTurn.Provider value={submitTurn}>
      <ComposerSubmit.Provider value={composerSubmit}>
      <ComposerStop.Provider value={composerStop}>
      <ServerTurn.Provider value={{ running: turnRunsOnServer, stop: stopServerTurn }}>
      <ComposerAccessory.Provider value={composerAccessory}>
      <Compose.Provider value={compose}>
      <AttachedFiles.Provider value={temporary ? null : attachedFiles}>
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

export default function ChatSurface({ children, chatId, stopRef, ...props }: Omit<ComponentProps<typeof CopilotKit>, "children"> & {
  children: (Thread: typeof ChatThread) => ReactNode;
  chatId: string;
  stopRef?: Ref<ChatStop>;
}) {
  const steeringDrop = useRef<(() => void) | null>(null);
  // A reply's first chart draws from plotly.js the browser fetched while the chat sat idle.
  useEffect(() => prefetchPlotly(), []);
  return (
    <CopilotKit {...props}>
      <SteeringDrop.Provider value={steeringDrop}>
        <ComputerStop chatId={chatId} stopRef={stopRef} />
        {children(ChatThread)}
      </SteeringDrop.Provider>
    </CopilotKit>
  );
}
