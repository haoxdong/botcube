"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type Key, type ReactElement, type ComponentProps, type ReactNode } from "react";
import { CopilotKit } from "@copilotkit/react-core/v2";
import {
  CopilotChat,
  CopilotChatInput,
  CopilotChatMessageView,
  CopilotChatView,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
} from "@copilotkit/react-core/v2";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import type { AbstractAgent } from "@ag-ui/client";
import { stoppedHere, toolCancellationStore, type SavedTurnFailure } from "./conversations";
import { endMoment, startMoment, type Moment } from "./latency";
import type { ModelList } from "./model-selection";
import { ScheduledTaskProposalCard, type ScheduledTaskProposal } from "./scheduled-tasks";
import MarkdownRenderer from "./markdown-renderer";
import { ReplyImageTurnRunning } from "./reply-image-turn";
import { webUiPlugin } from "@cartridge-ui";
import { Tool, ToolHeader, ToolContent, ToolOutput } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";

const UI_CONFIG = webUiPlugin.config;
const AGENT_ID = UI_CONFIG.agentId;
const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_SERVICE_URL ?? UI_CONFIG.chatServiceUrl;

function WelcomeScreen({ userName }: { userName?: string | undefined }) {
  const firstName = userName?.split(" ")[0];

  return (
    <div className="welcome-screen">
      <h1 className="welcome-title">{firstName ? `Hi ${firstName}, how can I help you?` : UI_CONFIG.title}</h1>
      {!firstName && <p className="welcome-desc">{UI_CONFIG.subtitle}</p>}
    </div>
  );
}

/** Extract the primary argument value for inline display (not JSON). */
function summarizeParams(params: Record<string, unknown> | undefined): string | undefined {
  return Object.values(params ?? {}).find((value): value is string => typeof value === "string");
}

/** deepagents' execute tool reports a non-zero exit only as this trailer on an otherwise successful result. */
const FAILED_COMMAND = /\n\[Command failed with exit code \d+\](\n\[Output was truncated due to size limits\])?$/;

function ToolCallRenderer({ agent }: { agent: AbstractAgent }) {
  const cancellations = toolCancellationStore(agent);
  const stoppedIds = useSyncExternalStore(cancellations.subscribe, cancellations.getSnapshot, cancellations.getSnapshot);
  useDefaultRenderTool({
    render: ({ name, toolCallId, status, parameters, result }) => {
      if (name === "propose_scheduled_task" && status === "complete") {
        return (
          <ScheduledTaskProposalCard
            chatServiceUrl={CHAT_SERVICE_URL}
            proposalId={toolCallId}
            proposal={parameters as ScheduledTaskProposal}
          />
        );
      }
      const state = status === "complete"
        ? FAILED_COMMAND.test(result ?? "") ? "output-error" : "output-available"
        : stoppedIds.has(toolCallId)
          ? "stopped"
          : status === "executing"
          ? "input-available"
          : "input-streaming";
      return (
        <Tool>
          <ToolHeader state={state} title={name} description={summarizeParams(parameters as Record<string, unknown> | undefined)} />
          {status === "complete" && result != null && (
            <ToolContent>
              <ToolOutput output={result} />
            </ToolContent>
          )}
        </Tool>
      );
    },
  }, [[...stoppedIds]]);
  return null;
}

function NoAddMenuButton() {
  return null;
}

const ComposerAccessory = createContext<React.ReactNode>(null);
const SubmitTurn = createContext<((message: string, submit: NonNullable<CopilotChatInputProps["onSubmitMessage"]>) => void) | null>(null);
/** Stops the chat's Turn that runs on the server with no stream here, while one does. */
const ServerTurnStop = createContext<(() => void) | null>(null);

/** CopilotChat's input with the cartridge's accessory above its text box, in the composer's own overlay. */
function ComposerInput(props: CopilotChatInputProps) {
  const accessory = useContext(ComposerAccessory);
  const submitTurn = useContext(SubmitTurn);
  const stopServerTurn = useContext(ServerTurnStop);
  const submit = props.onSubmitMessage;
  // A Turn that runs on the server with no stream here shows the same Stop as one streaming here.
  const stopsServerTurn = !props.isRunning && stopServerTurn !== null;
  const isRunning = props.isRunning || stopsServerTurn;
  return (
    <>
      {/* CopilotChatInput's column (CopilotKit's own classes), so the accessory lines up with the text box in it. */}
      {accessory && (
        <div className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:sm:px-0">
          <div className="composer-accessory">{accessory}</div>
        </div>
      )}
      {/* CopilotChatInput's send button turns into an icon-only Stop while the agent runs, with no name of its own. */}
      <CopilotChatInput
        {...props}
        isRunning={isRunning}
        {...(!props.onAddFile && !props.toolsMenu?.length ? {
          addMenuButton: NoAddMenuButton,
        } : {})}
        textArea={{
          onKeyDownCapture: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (isRunning && event.key === "Enter" && !event.shiftKey && !event.currentTarget.value.trim()) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
        }}
        {...(stopsServerTurn ? { onStop: stopServerTurn } : {})}
        {...(submit && submitTurn ? { onSubmitMessage: (message: string) => submitTurn(message, submit) } : {})}
        {...(props.mode !== "transcribe" ? {
          sendButton: { "aria-label": isRunning ? "Stop" : "Send" },
        } : {})}
      />
    </>
  );
}

/** Why the last Turn failed, and how to resend it when the send never reached the Chat Service. */
interface TurnFailure {
  message: string;
  question?: string | undefined;
  retry?: () => void;
}

const RunError = createContext<TurnFailure | null>(null);

/** A Turn that ended in a run error, as the chat shows it. */
const couldNotAnswer = (message: string): TurnFailure => ({ message: `The agent could not answer: ${message}` });

const JUMP_SETTLE_FRAMES = 3;

function holdAtBottom(scroller: Element) {
  let still = 0;
  const hold = () => {
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    if (scroller.scrollTop < bottom) {
      scroller.scrollTop = bottom;
      still = 0;
    }
  };
  const release = () => {
    scroller.removeEventListener("scroll", hold);
    scroller.removeEventListener("pointerdown", release);
  };
  const frame = () => {
    still += 1;
    if (still < JUMP_SETTLE_FRAMES) requestAnimationFrame(frame);
    else release();
  };
  scroller.addEventListener("scroll", hold);
  scroller.addEventListener("pointerdown", release);
  hold();
  requestAnimationFrame(frame);
}

/** CopilotKit's spring mistakes momentum for a new user scroll and cancels the jump. */
function JumpToBottom({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <CopilotChatView.ScrollToBottomButton
      {...props}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        const list = event.currentTarget.closest(".chat-wrapper")?.querySelector('[data-testid="copilot-message-list"]');
        const scroller = list && scrollParent(list);
        if (scroller) holdAtBottom(scroller);
        onClick?.(event);
      }}
    />
  );
}

/**
 * CopilotChat's scroll view props: open a chat at its latest message, and stay there as the chat grows, not
 * smooth-scrolled down to it; jump to it with JumpToBottom. A constant, since CopilotKit re-renders a slot whose value
 * changes.
 */
const CHAT_SCROLL_VIEW = { initial: "instant", resize: "instant", scrollToBottomButton: JumpToBottom } as const;

/**
 * The assistant message slot: render markdown and reply images. The renderer loads with this lazy chat surface: loaded
 * after it, every reply showed blank as the surface replaced the page's plain-text history (#3539). A constant, like
 * CHAT_SCROLL_VIEW.
 */
const ASSISTANT_MESSAGE = { markdownRenderer: ({ content }: { content: string }) => <MarkdownRenderer content={content} /> };

/** Ends `moment` as it is first on screen. */
function MomentEnds({ moment }: { moment: Moment }) {
  useEffect(() => endMoment(moment), [moment]);
  return null;
}

/** How many of a chat's latest message rows it opens with, and how many earlier rows each scroll up to its top adds. */
const MESSAGE_ROWS_PER_PAGE = 4;

/**
 * Where the page of MESSAGE_ROWS_PER_PAGE message rows that ends at `end` starts. A message's row is the element keyed
 * by its ID; CopilotKit 1.61 lays out custom-message slots around each, most rendering nothing, and the page starts at
 * its first message's.
 */
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

/**
 * The element that scrolls `element`, CopilotChat's scroll view, while there is more to scroll than it shows. Its
 * content wrapper is styled to scroll too, but is as tall as its content, so it never does.
 */
function scrollParent(element: Element): Element | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** A row the user was reading, its scroll view, and where the row was in the scroll view's content. */
type ReadRow = { row: Element; scroller: Element; at: number };

/**
 * The row the user reads in `scroller`: the first of `list`'s that shows below its top. A row that renders nothing, such
 * as a tool's result, is no row to read: rows rendering below it would move the row the user sees.
 */
function rowRead(list: Element, scroller: Element): ReadRow | null {
  const top = scroller.getBoundingClientRect().top;
  const row = [...list.children].find((child) => {
    const box = child.getBoundingClientRect();
    return box.bottom > Math.max(box.top, top);
  });
  return row === undefined ? null : { row, scroller, at: row.getBoundingClientRect().top + scroller.scrollTop };
}

/**
 * Scrolls by as much as the content above `read`'s row grew, so the row stays where it is on screen; at the scroll view's
 * bottom, content above shrinking leaves the view there.
 */
function keepInPlace(read: ReadRow) {
  if (!read.row.isConnected) return;
  const { scroller } = read;
  const at = read.row.getBoundingClientRect().top + scroller.scrollTop;
  // Growth below the row, such as a streaming Turn, moves nothing: the scroll view keeps up with it itself.
  if (Math.abs(at - read.at) < 1) return;
  // At its bottom, which CHAT_SCROLL_VIEW's instant resize keeps 1px short of, the view stays there as the content above
  // shrinks: the scroll view takes a scroll up it did not make for the user's and stops keeping to its bottom.
  const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2;
  if (!(atBottom && at < read.at)) scroller.scrollTop += at - read.at;
  read.at = at;
}

/**
 * Ends the entrance each message row plays as it mounts, for rows that are history, not messages arriving: it faded the
 * whole history in as a chat opened, and earlier rows in as they joined (#3539).
 */
function finishEntrances(list: Element) {
  for (const animation of list.getAnimations({ subtree: true })) {
    if (animation instanceof CSSAnimation && animation.animationName === "messageIn") animation.finish();
  }
}

/**
 * The message list's ref: the rows a chat opens with show at once. A constant, so React calls it only as the list mounts,
 * after the rows in it have.
 */
const showRowsAtOnce = (list: HTMLDivElement | null) => {
  if (list !== null) finishEntrances(list);
};

/**
 * A chat's message rows, opening at its latest rows alone: each time the user scrolls up to the first row laid out, the
 * rows before it join, where they were read from. Laying out every message of a long chat before its first paint took
 * seconds.
 */
function MessageRows({ rows, messages }: { rows: ReactElement[]; messages: readonly { id: string }[] }) {
  const [firstKey, setFirstKey] = useState<Key | null>(null);
  const kept = firstKey === null ? -1 : rows.findIndex((row) => row.key === firstKey);
  const messageIds = new Set(messages.map(({ id }) => id));
  // The rows a chat opens with, or a replaced history's, which has no row laid out yet.
  const first = kept === -1 ? pageStart(rows, rows.length, messageIds) : kept;
  const firstRowKey = rows[first]?.key ?? null;
  if (kept === -1 && firstRowKey !== firstKey) setFirstKey(firstRowKey);

  const rowsRef = useRef({ rows, messageIds });
  rowsRef.current = { rows, messageIds };
  const earlier = useRef<HTMLDivElement>(null);
  // The row the user is reading as earlier rows join above it, and where it was in the scroll view's content.
  const reading = useRef<ReadRow | null>(null);
  useEffect(() => {
    const marker = earlier.current;
    if (first === 0 || marker === null) return undefined;
    // The top in view, earlier rows join, including as this observer starts: the rows that joined last, held in place,
    // left it in view only when too short to carry it out of view, and it would never come into view again.
    let reported = false;
    const observer = new IntersectionObserver(([entry]) => {
      const atStart = !reported;
      reported = true;
      if (!entry?.isIntersecting) return;
      const scroller = scrollParent(marker);
      const list = marker.parentElement;
      // Rows joining again as this observer starts, before the user scrolls, keep holding the row the user was reading,
      // not the rows that just joined above it, which would leave it to move as they render. Later, the user has scrolled
      // up to the top, and reads the row there.
      if (!(atStart && reading.current?.row.isConnected)) reading.current = scroller && list && rowRead(list, scroller);
      const laidOut = rowsRef.current;
      setFirstKey(laidOut.rows[pageStart(laidOut.rows, first, laidOut.messageIds)]?.key ?? null);
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [first]);
  // The rows joining above keep the row the user was reading where it was, as they lay out and as their markdown renders
  // after (the list opts out of browser scroll anchoring, which Safari lacks).
  useLayoutEffect(() => {
    const read = reading.current;
    const list = read?.row.parentElement;
    if (read === null || list == null) return undefined;
    finishEntrances(list);
    keepInPlace(read);
    let kept = read.scroller.scrollTop;
    const observer = new ResizeObserver(() => {
      keepInPlace(read);
      kept = read.scroller.scrollTop;
    });
    // A scroll of the user's own moves the hold to the row now at the top of the view: rows still rendering above the
    // row they scrolled away from would otherwise carry the view off with it.
    const scrolled = () => {
      if (read.scroller.scrollTop === kept) return;
      kept = read.scroller.scrollTop;
      const now = rowRead(list, read.scroller);
      if (now !== null) Object.assign(read, now);
    };
    observer.observe(list);
    read.scroller.addEventListener("scroll", scrolled);
    return () => {
      observer.disconnect();
      read.scroller.removeEventListener("scroll", scrolled);
    };
  }, [first]);

  return (
    <>
      {first > 0 && <div ref={earlier} aria-hidden />}
      {rows.slice(first)}
    </>
  );
}

/**
 * CopilotChat's messages, then why the last Turn failed, in the message flow below them. The messages are laid out
 * here, as CopilotKit 1.61's own list does, because a `children` render prop stops CopilotKit virtualizing a chat over 50
 * messages: its rows start at an estimated height, so a long chat kept moving for a second after opening.
 */
function ChatMessages(props: CopilotChatMessageViewProps) {
  const runError = useContext(RunError);
  return (
    <>
      <CopilotChatMessageView {...props} assistantMessage={ASSISTANT_MESSAGE}>
        {({ messageElements, messages, isRunning, interruptElement }) => (
          <div ref={showRowsAtOnce} data-copilotkit data-testid="copilot-message-list" className="copilotKitMessages cpk:flex cpk:flex-col">
            <ReplyImageTurnRunning.Provider value={isRunning}>
              <MessageRows rows={messageElements} messages={messages} />
            </ReplyImageTurnRunning.Provider>
            {interruptElement}
            {isRunning && messages.at(-1)?.role !== "reasoning" && (
              <div className="cpk:mt-2">
                <CopilotChatMessageView.Cursor />
                <MomentEnds moment="send-acknowledged" />
              </div>
            )}
          </div>
        )}
      </CopilotChatMessageView>
      {runError !== null && (
        <p className="chat-run-error" role="alert">{runError.message}</p>
      )}
      {runError?.question && (
        <div className="chat-failed-question cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:sm:px-0 cpk:mt-2">
          <p>Your question</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{runError.question}</p>
        </div>
      )}
      {runError?.retry && (
        <Button type="button" className="chat-turn-retry" onClick={runError.retry}>
          Retry
        </Button>
      )}
    </>
  );
}

const CHAT_INPUT = Object.assign(ComposerInput, CopilotChatInput);
const CHAT_MESSAGES = Object.assign(ChatMessages, { Cursor: CopilotChatMessageView.Cursor });

/** Captures the first Enter keypress so the server-owned sidebar can refresh. */
function ChatThread({
  agent,
  threadId,
  onMessageSubmitted,
  showWelcome,
  userName,
  composerAccessory,
  models,
  isAccountCurrent,
  stopServerTurn,
  savedFailure,
  children,
}: {
  agent: AbstractAgent;
  threadId: string;
  onMessageSubmitted: () => void;
  /** The account's models; until they load, a Turn would run on another account's model or the default. */
  models: ModelList;
  /** False while a sign-in has switched the account and the page has not rendered the new one's models. */
  isAccountCurrent: () => boolean;
  /** Stops the chat's Turn that runs on the server with no stream here, while one does. */
  stopServerTurn: (() => void) | null;
  /** Why the chat's latest Turn failed, as the Chat Service recorded it, for a page that did not stream it. */
  savedFailure: SavedTurnFailure | null;
  showWelcome: boolean;
  userName?: string | undefined;
  composerAccessory?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const firedRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), []);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // ADR 0030: a failed Turn shows why, until the next message is sent.
  const [runError, setRunError] = useState<TurnFailure | null>(null);
  const submittedQuestion = useRef<string | undefined>(undefined);
  // A Turn that failed with no page attached shows why once the chat opens on it.
  useEffect(() => {
    if (savedFailure !== null) setRunError(couldNotAnswer(savedFailure.message));
  }, [savedFailure]);
  // A Retry reads whether the account's models have loaded since the send it repeats.
  const accountRef = useRef({ models, isAccountCurrent });
  accountRef.current = { models, isAccountCurrent };
  const modelsReady = () => accountRef.current.isAccountCurrent() && accountRef.current.models.loaded;
  const submitTurn = (message: string, submit: NonNullable<CopilotChatInputProps["onSubmitMessage"]>) => {
    if (!modelsReady()) {
      const { models: accountModels } = accountRef.current;
      // Nothing loads the models again after a failure, so only a reload can.
      setRunError(
        !accountModels.loaded && accountModels.error !== null
          ? { message: `${accountModels.error}. Reload the page to send a message.` }
          : { message: "Your models are still loading. Send it again once they have.", retry: () => submitTurn(message, submit) },
      );
      return;
    }
    if (!navigator.onLine) {
      // No CopilotKit submit callback, message addition, or request has occurred: retry is safe.
      setRunError({ message: `Couldn't reach ${UI_CONFIG.title}. Check your connection.`, retry: () => submitTurn(message, submit) });
      return;
    }
    setRunError(null);
    startMoment("send-acknowledged");
    submittedQuestion.current = message;
    void submit(message);
  };
  useEffect(() => {
    // Keyboard and Send-button sends both add the user's message to the agent.
    const subscription = agent.subscribe({
      onNewMessage: ({ message }) => {
        if (message.role === "user") setRunError(null);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.shiftKey || !navigator.onLine || !modelsReady()) return;
    const text = e.currentTarget.querySelector("textarea")?.value.trim();
    if (!text) return;
    if (firedRef.current) return;
    firedRef.current = true;
    onMessageSubmitted();
    refreshTimerRef.current = window.setTimeout(onMessageSubmitted, 1000);
  };

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
    <div className="chat-wrapper" ref={wrapperRef} onKeyDownCapture={handleKeyDown}>
      {showWelcome && <WelcomeScreen userName={userName} />}
      <ToolCallRenderer agent={agent} />
      <SubmitTurn.Provider value={submitTurn}>
      <ServerTurnStop.Provider value={stopServerTurn}>
      <ComposerAccessory.Provider value={composerAccessory}>
        <RunError.Provider value={runError}>
          <CopilotChat
            agentId={AGENT_ID}
            threadId={threadId}
            labels={{ chatInputPlaceholder: "Ask anything", chatDisclaimerText: UI_CONFIG.disclaimer }}
            className="chat-full-height"
            messageView={CHAT_MESSAGES}
            input={CHAT_INPUT}
            scrollView={CHAT_SCROLL_VIEW}
            // Stop aborts the Turn's stream, or the Harness ends the Turn the user stopped here with TURN_STOPPED: the
            // user's choice, not a failure. A TURN_STOPPED for a Turn a newer one replaced still shows.
            onError={(event) => {
              const error = "error" in event ? event.error : new Error("Chat content failed to load");
              if (error.name === "AbortError") return;
              if ((error as Error & { code?: unknown }).code === "TURN_STOPPED" && stoppedHere(agent)) return;
              // A failed response does not establish whether the service already accepted the Turn.
              const status = (error as Error & { status?: unknown }).status;
              setRunError(
                "code" in event && (event.code === "agent_run_failed_event" || event.code === "agent_run_failed") && typeof status === "number" && status >= 500 && status < 600
                  ? {
                    message: `${UI_CONFIG.title} couldn't confirm your message was received. Check this chat before sending it again.`,
                    question: submittedQuestion.current,
                  }
                  : couldNotAnswer(error.message),
              );
            }}
          />
        </RunError.Provider>
      </ComposerAccessory.Provider>
      </ServerTurnStop.Provider>
      </SubmitTurn.Provider>
      <div ref={pickerRef} style={{ position: "absolute", visibility: "hidden" }}>{children}</div>
    </div>
  );
}

export default function ChatSurface({ children, ...props }: Omit<ComponentProps<typeof CopilotKit>, "children"> & { children: (Thread: typeof ChatThread) => ReactNode }) {
  return <CopilotKit {...props}>{children(ChatThread)}</CopilotKit>;
}
