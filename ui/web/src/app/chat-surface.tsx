"use client";

import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type Key, type ReactElement, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
import { CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  type CopilotChatReasoningMessage,
  CopilotChatUserMessage,
  CopilotChatView,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
} from "@copilotkit/react-core/v2";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { Menu } from "@base-ui/react/menu";
import { FilePlusCorner, Paperclip, Plus } from "lucide-react";
import type { AbstractAgent } from "@ag-ui/client";
import { runStarted, stoppedHere, toolCancellationStore, type SavedTurnFailure } from "./conversations";
import { endMoment, startMoment, type Moment } from "./latency";
import type { ModelList } from "./model-selection";
import { agentFiles } from "./agent-files";
import { ScheduledTaskProposalCard, type ScheduledTaskProposal } from "./scheduled-tasks";
import { OpenScheduledRun, ScheduledRunCard, scheduledRunOf, type ReachedScheduledRun } from "./scheduled-run-card";
import MarkdownRenderer from "./markdown-renderer";
import { ReplyTurnRunning } from "./reply-turn";
import { pageHeld } from "./phone-page-hold";
import { useComposerBacking } from "./phone-composer-backing";
import { useComposerResizesOnLayout } from "./composer-layout-height";
import { useScrollUpClosesKeyboard } from "./phone-keyboard-dismiss";
import { useIsPhone } from "./phone-query";
import { webUiPlugin } from "@cartridge-ui";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { Button } from "@/components/ui/button";
import { ComposerFilePicker, SentFileCards, attachPastedImages, messageWithFiles, sentFilesOf, useComposerFiles, type ComposerFiles } from "./composer-files";
import { ThoughtStep, ToolStep, Worklog, worklogRows } from "./worklog";
import { useQueuedFollowUp } from "./queued-follow-up";

const UI_CONFIG = webUiPlugin.config;
const AGENT_ID = UI_CONFIG.agentId;
const CHAT_SERVICE_URL = chatServiceUrl();

function WelcomeScreen({ userName }: { userName?: string | undefined }) {
  const firstName = userName?.split(" ")[0];

  return (
    <div className="welcome-screen">
      <h1 className="welcome-title">{firstName ? `Hi ${firstName}, how can I help you?` : UI_CONFIG.title}</h1>
      {!firstName && <p className="welcome-desc">{UI_CONFIG.subtitle}</p>}
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
          name={name}
          params={parameters as Record<string, unknown> | undefined}
          status={status === "complete" ? "complete" : stoppedIds.has(toolCallId) ? "stopped" : "running"}
          output={status === "complete" ? result ?? undefined : undefined}
          commandPrefix={webUiPlugin.commandPrefix}
        />
      );
    },
  }, [[...stoppedIds]]);
  return null;
}

function NoAddMenuButton() {
  return null;
}

/**
 * The composer's + and its menu, as ChatGPT's: a white popover over the composer's left edge whose items open the file
 * picker, Add photos for images and Add files for any file. CopilotKit's own menu draws no icons.
 */
function AddMenu({ disabled, onAddFile }: { disabled?: boolean | undefined; onAddFile?: ((accept?: string) => void) | undefined }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} data-testid="copilot-add-menu-button" aria-label="Add photos & files" disabled={disabled ?? false}>
        <Plus size={20} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="add-menu-positioner" anchor={() => trigger.current?.closest(".copilotKitInput") ?? null} side="top" align="start" sideOffset={8}>
          <Menu.Popup className="add-menu">
            <Menu.Item className="add-menu-item" onClick={() => onAddFile?.("image/*")}>
              <Paperclip size={20} aria-hidden />
              Add photos
            </Menu.Item>
            <Menu.Item className="add-menu-item" onClick={() => onAddFile?.()}>
              <FilePlusCorner size={20} aria-hidden />
              Add files
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

type Submit = NonNullable<CopilotChatInputProps["onSubmitMessage"]>;

const ComposerAccessory = createContext<React.ReactNode>(null);
const SubmitTurn = createContext<((message: string, submit: Submit, retry?: () => void) => boolean) | null>(null);
/** Where the composer leaves CopilotKit's send, so a held follow-up goes as one typed now would. */
const ComposerSubmit = createContext<{ current: Submit | null } | null>(null);
/** The follow-up held until the running Turn ends, shown as pending in the chat. */
const QueuedMessage = createContext<{ text: string; unkept: boolean; cancel: () => void } | null>(null);
/** Stops the chat's Turn that runs on the server with no stream here, while one does. */
const ServerTurnStop = createContext<(() => void) | null>(null);
/** The files attached in the chat's composer; null outside a chat, where the composer has no +. */
const AttachedFiles = createContext<ComposerFiles | null>(null);

/**
 * The + slot: with files to attach, our menu, whose items open the file picker for the types they name, and any file
 * from CopilotKit's slash menu; none with nothing to add.
 */
function addMenuSlot(attached: ComposerFiles | null, picker: RefObject<HTMLInputElement | null>) {
  if (!attached) return { addMenuButton: NoAddMenuButton };
  const onAddFile = (accept = "") => {
    if (!picker.current) return;
    picker.current.accept = accept;
    picker.current.click();
  };
  return { addMenuButton: AddMenu, onAddFile };
}

/**
 * The message as sent, naming the attached files by the paths the agent reads them by in the Turn it starts; they leave
 * the composer once it goes, as CopilotChatInput clears its text. A send held back (models loading, offline) keeps them.
 */
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

/** CopilotChatInput's send button turns into an icon-only Stop while the agent runs, with no name of its own; Stop is never held back. */
function sendButtonSlot(mode: CopilotChatInputProps["mode"], isRunning: boolean, held: boolean, sendFiles?: () => void) {
  if (mode === "transcribe") return {};
  return { sendButton: { "aria-label": isRunning ? "Stop" : "Send", ...(!isRunning && sendFiles ? { disabled: held, onClick: sendFiles } : held && !isRunning ? { disabled: true } : {}) } };
}

/**
 * Swallows the Enter that would send, while the message is `held` for its files, or would stop a running Turn from an
 * empty text box.
 */
function holdEnter(held: boolean, isRunning: boolean, sendFiles?: () => void) {
  return (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && (held || sendFiles || (isRunning && !event.currentTarget.value.trim()))) {
      event.preventDefault();
      event.stopPropagation();
      if (!held) sendFiles?.();
    }
  };
}

/**
 * CopilotChat's input with the cartridge's accessory above its text box, in the composer's own overlay, and the files
 * attached with its + or pasted into its text as chips inside its box, above the text.
 */
function ComposerInput(props: CopilotChatInputProps) {
  const accessory = useContext(ComposerAccessory);
  const submitTurn = useContext(SubmitTurn);
  const stopServerTurn = useContext(ServerTurnStop);
  const attached = useContext(AttachedFiles);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  const picker = useRef<HTMLInputElement>(null);
  // A message waits for every attached file to upload; a failed one waits on its Retry or Remove.
  const held = attached?.sendable === false;
  const composerSubmit = useContext(ComposerSubmit);
  const submit = props.onSubmitMessage;
  const [draft, setDraft] = useState(props.value ?? "");
  const fileOnly = !((props.value ?? draft).trim()) && (attached?.files.length ?? 0) > 0;
  const sendFiles = fileOnly && submit && submitTurn ? () => sendWithFiles("", attachedRef, submitTurn, submit) : undefined;
  useLayoutEffect(() => {
    if (composerSubmit !== null) composerSubmit.current = submit ?? null;
  });
  // A Turn that runs on the server with no stream here shows the same Stop as one streaming here.
  const stopsServerTurn = !props.isRunning && stopServerTurn !== null;
  const isRunning = props.isRunning || stopsServerTurn;
  return (
    <>
      {attached && <ComposerFilePicker attached={attached} picker={picker} />}
      {/* CopilotChatInput's column (CopilotKit's own classes), so the accessory lines up with the text box in it. */}
      {accessory && (
        <div className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:sm:px-0">
          <div className="composer-accessory">{accessory}</div>
        </div>
      )}
      <CopilotChatInput
        {...props}
        isRunning={isRunning}
        onChange={(value: string) => { setDraft(value); props.onChange?.(value); }}
        disclaimer="chat-disclaimer"
        {...addMenuSlot(attached, picker)}
        textArea={{ onKeyDownCapture: holdEnter(held, isRunning, sendFiles), ...(attached ? { onPaste: attachPastedImages(attached.add) } : {}) }}
        {...(stopsServerTurn ? { onStop: stopServerTurn } : {})}
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

/** Why the last Turn failed, and how to resend it when the send never reached the Chat Service. */
interface TurnFailure {
  message: string;
  question?: string | undefined;
  retry?: () => void;
}

const RunError = createContext<TurnFailure | null>(null);

/** Whether the Turn streaming here has started: its RUN_STARTED has arrived. */
const RunStarted = createContext(false);

/** The message a chat opens at, as Open on a run's card opens its Side Chat at the run; null, it opens at its latest. */
const OpensAt = createContext<string | null>(null);

/** A Turn that ended in a run error, as the chat shows it. */
const couldNotAnswer = (message: string): TurnFailure => ({ message: `The agent could not answer: ${message}` });

const JUMP_SETTLE_FRAMES = 3;

/** Where `scroller`'s scroll events fire: the page's own scroller fires them on the window. */
function eventsOf(scroller: Element): EventTarget {
  return scroller === document.scrollingElement ? window : scroller;
}

/** The top of what `scroller` shows, on screen: the page's is the screen's top. */
function viewTop(scroller: Element): number {
  return scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
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

/**
 * Holds the row of message `id` at the top of the chat's view, under its header, as the chat opens: its rows and their
 * markdown lay out over the first frames. A scroll of the user's own lets go.
 */
function holdAtRow(wrapper: Element, id: string): () => void {
  const started = performance.now();
  let frame = 0;
  const hold = (now: number) => {
    const row = wrapper.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    const scroller = row && scrollParent(row);
    if (row && scroller) {
      const header = wrapper.closest(".app-shell")?.querySelector(".chat-header")?.getBoundingClientRect().bottom ?? 0;
      scroller.scrollTop += row.getBoundingClientRect().top - Math.max(viewTop(scroller), header);
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
function JumpToBottom({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <CopilotChatView.ScrollToBottomButton
      {...props}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        const scroller = messagesScroller(event.currentTarget.closest(".chat-wrapper"));
        if (scroller) holdAtBottom(scroller);
        onClick?.(event);
      }}
    />
  );
}

type ScrollViewProps = ComponentProps<typeof CopilotChatView.ScrollView>;

/** How far the page can scroll. */
function pageBottom(page: Element): number {
  return page.scrollHeight - page.clientHeight;
}

/**
 * How far CopilotKit lifts the composer above a keyboard that shrinks only the visual viewport, as Android Chrome's
 * does: by the keyboard's height, once it passes 150px, as CopilotKit's useKeyboardHeight measures it.
 */
function useKeyboardLift(): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const measure = () => {
      const keyboard = Math.max(0, window.innerHeight - viewport.height);
      setLift(keyboard > 150 ? keyboard : 0);
    };
    measure();
    viewport.addEventListener("resize", measure);
    return () => viewport.removeEventListener("resize", measure);
  }, []);
  return lift;
}

/**
 * The phone's scroll view: the chat in the page's flow, which scrolls it. As CopilotKit's own view does on its box, it
 * opens at the latest message, keeps to the bottom as the chat grows until the user scrolls up, and shows the jump to
 * the bottom while away from it, above the composer. Scrolling it up closes the keyboard, and the composer's lift above
 * the keyboard gets its room below the chat.
 */
function PageScrollView({ children, inputContainerHeight = 0, isResizing = false }: ScrollViewProps) {
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(useContext(OpensAt) === null);
  const follows = useRef<() => void>(undefined);
  const backing = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lift = useKeyboardLift();
  useComposerBacking(backing);
  useScrollUpClosesKeyboard();
  useLayoutEffect(() => {
    const page = document.scrollingElement;
    const box = content.current;
    const shell = box?.closest(".app-shell");
    if (page === null || !box || !shell) throw new Error("The phone chat needs the page's scroller, its content and its screen");
    let last = page.scrollTop;
    let input = false;
    let away = false;
    // Whether the page is the chat's: neither held by the drawer nor Plugins's, under which the chat stays mounted.
    // Back from Plugins, the chat takes its own place again.
    const ours = () => {
      if (pageHeld()) return false;
      if (box.closest("[hidden]") !== null) {
        away = true;
        return false;
      }
      if (away) {
        away = false;
        page.scrollTop = pinned.current ? pageBottom(page) : last;
      }
      return true;
    };
    const follow = () => {
      if (!ours()) return;
      if (pinned.current) page.scrollTop = pageBottom(page);
      last = page.scrollTop;
      setAtBottom(pageBottom(page) - page.scrollTop < 2);
    };
    const scrolled = () => {
      if (!ours()) return;
      const now = page.scrollTop;
      const bottom = pageBottom(page) - now < 2;
      if (bottom) pinned.current = true;
      else if (now < last && input) pinned.current = false;
      else if (pinned.current) page.scrollTop = pageBottom(page);
      last = page.scrollTop;
      input = false;
      setAtBottom(pageBottom(page) - page.scrollTop < 2);
    };
    // A finger, wheel or key on the chat's screen. Typing in or scrolling a field, such as the composer, and a gesture
    // on another surface, such as the Agent Profile sheet, scroll no chat.
    const intends = (event: Event) => {
      const { target } = event;
      if (target instanceof Element) {
        if (!target.contains(shell) && !shell.contains(target)) return;
        if (target.closest("input, textarea, [contenteditable]") !== null) return;
      }
      input = true;
    };
    follows.current = follow;
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(box);
    window.addEventListener("scroll", scrolled, { passive: true });
    for (const type of ["wheel", "touchmove", "keydown"]) window.addEventListener(type, intends, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", scrolled);
      for (const type of ["wheel", "touchmove", "keydown"]) window.removeEventListener(type, intends);
    };
  }, []);
  // CopilotKit pads the chat by the composer's height once it measures it, after the chat opens, and the keyboard's
  // room comes and goes with the keyboard: the chat keeps to its bottom in that same update, as no frame should show it
  // short of its end.
  useLayoutEffect(() => follows.current?.(), [inputContainerHeight, lift]);
  return (
    <>
      {/* CopilotKit's own scroll view's gutter. */}
      <div ref={content} className="cpk:px-4 cpk:@3xl:px-0">{children}</div>
      <div className="chat-keyboard-room" style={{ height: `${lift}px` }} aria-hidden="true" />
      <div ref={backing} className="chat-composer-backing" aria-hidden="true" />
      {!atBottom && !isResizing && (
        <div className="chat-page-jump" style={{ bottom: `${inputContainerHeight + 16}px` }}>
          <JumpToBottom onClick={() => {
            pinned.current = true;
          }} />
        </div>
      )}
    </>
  );
}

/** StickToBottom's own props, which CopilotChatView.ScrollView passes on to it but does not type. */
const STICK_INSTANTLY: { initial: "instant" | false; resize: "instant" } = { initial: "instant", resize: "instant" };

/**
 * CopilotChat's scroll view: open a chat at its latest message, and stay there as the chat grows, not smooth-scrolled
 * down to it; jump to it with JumpToBottom. On a phone, the page scrolls. A constant, since CopilotKit re-renders a slot
 * whose value changes.
 */
function ChatScrollView(props: ScrollViewProps) {
  const opensAt = useContext(OpensAt);
  if (useIsPhone()) return <PageScrollView {...props} />;
  // A chat opening at an earlier message leaves the latest to the user's jump.
  const stick = opensAt === null ? STICK_INSTANTLY : { ...STICK_INSTANTLY, initial: false };
  return <CopilotChatView.ScrollView {...props} {...stick} scrollToBottomButton={JumpToBottom} />;
}
const CHAT_SCROLL_VIEW = ChatScrollView;

const MARKDOWN_RENDERER = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;

/**
 * The assistant message slot: a scheduled run's card, or markdown and reply images. The renderer loads with this lazy
 * chat surface: loaded after it, every reply showed blank as the surface replaced the page's plain-text history (#3539).
 * A constant, like CHAT_SCROLL_VIEW.
 */
function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const run = scheduledRunOf(props.message);
  if (run !== null) return <div data-message-id={props.message.id}><ScheduledRunCard run={run} /></div>;
  return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN_RENDERER} />;
}

/** The slot types its component with CopilotKit's sub-components, which a component slot never reads: it only renders it. */
const ASSISTANT_MESSAGE_SLOT = AssistantMessage as typeof CopilotChatAssistantMessage;

/**
 * The reasoning message slot: a thought, as a step of its Turn's Worklog. A constant, like CHAT_SCROLL_VIEW. CopilotKit
 * types the slot as its own component, statics included, but renders only the function.
 */
const REASONING_MESSAGE = ThoughtStep as unknown as typeof CopilotChatReasoningMessage;

/** A user message's files as cards, then its bubble holding what the user typed, none when they typed nothing. */
function SentMessage({ content }: { content: string }) {
  const { text, paths } = sentFilesOf(content);
  return (
    <>
      <SentFileCards paths={paths} fileUrl={agentFiles.url} />
      {text && <CopilotChatUserMessage.MessageRenderer content={text} />}
    </>
  );
}

/** The user message slot: CopilotKit's own, its text shown by SentMessage. A constant, like CHAT_SCROLL_VIEW. */
const USER_MESSAGE = { messageRenderer: SentMessage };

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
  // A phone's chat scrolls the page (PageScrollView).
  const page = document.scrollingElement;
  return page !== null && page.scrollHeight > page.clientHeight ? page : null;
}

/** The element that scrolls the messages of the chat in `wrapper`, while there is more to scroll than it shows. */
function messagesScroller(wrapper: Element | null): Element | null {
  const list = wrapper?.querySelector('[data-testid="copilot-message-list"]');
  return list ? scrollParent(list) : null;
}

/**
 * Whether the chat in `wrapper` has padded its content by its composer's height. CopilotKit measures the composer some
 * commits after it mounts and pads by only 32px until then, so a chat at its end before that moves once the padding
 * arrives (#3697). A chat without both parts has no composer to make room for.
 */
function hasComposerRoom(wrapper: Element | null): boolean {
  const content = wrapper?.querySelector<HTMLElement>('[data-testid="copilot-scroll-content"]');
  const composer = wrapper?.querySelector<HTMLElement>('[data-testid="copilot-input-overlay"]');
  return !content || !composer || parseFloat(content.style.paddingBottom) >= composer.offsetHeight;
}

/** A row the user was reading, its scroll view, and where the row was in the scroll view's content. */
type ReadRow = { row: Element; scroller: Element; at: number };

/**
 * The row the user reads in `scroller`: the first of `list`'s that shows below its top. A row that renders nothing, such
 * as a tool's result, is no row to read: rows rendering below it would move the row the user sees.
 */
function rowRead(list: Element, scroller: Element): ReadRow | null {
  const top = viewTop(scroller);
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
  const opensAt = useContext(OpensAt);
  const at = kept === -1 && opensAt !== null ? rows.findIndex((row) => row.key === opensAt) : -1;
  // The rows a chat opens with, up to the message it opens at, or a replaced history's, which has no row laid out yet.
  const first = kept === -1 ? pageStart(rows, at === -1 ? rows.length : at + 1, messageIds) : kept;
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
    const events = eventsOf(read.scroller);
    events.addEventListener("scroll", scrolled);
    return () => {
      observer.disconnect();
      events.removeEventListener("scroll", scrolled);
    };
  }, [first]);

  return (
    <>
      {first > 0 && <div ref={earlier} aria-hidden />}
      {rows.slice(first)}
    </>
  );
}

/** The held follow-up's files as cards, then its faded bubble. */
function QueuedSent({ message }: { message: string }) {
  const { text, paths } = sentFilesOf(message);
  return (
    <>
      <SentFileCards paths={paths} fileUrl={agentFiles.url} />
      {text && <div className="chat-queued-bubble">{text}</div>}
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
  const queued = useContext(QueuedMessage);
  const started = useContext(RunStarted);
  return (
    <>
      <CopilotChatMessageView {...props} assistantMessage={ASSISTANT_MESSAGE_SLOT} userMessage={USER_MESSAGE} reasoningMessage={REASONING_MESSAGE}>
        {({ messageElements, messages, isRunning, interruptElement }) => {
          const last = messages.at(-1);
          return (
            <div ref={showRowsAtOnce} data-copilotkit data-testid="copilot-message-list" className="copilotKitMessages cpk:flex cpk:flex-col">
              <ReplyTurnRunning.Provider value={isRunning}>
                <MessageRows rows={worklogRows(messageElements, messages, isRunning)} messages={messages} />
              </ReplyTurnRunning.Provider>
              {/* Until the Turn shows its work, the cursor says it runs, then from RUN_STARTED its Worklog's head. */}
              {isRunning && started && last?.role === "user" && <Worklog id={last.id} running asked={last.id} />}
              {interruptElement}
              {isRunning && last?.role !== "reasoning" && (
                <div className="cpk:mt-2">
                  {(last?.role ?? "user") === "user" && !started && <CopilotChatMessageView.Cursor />}
                  <MomentEnds moment="send-acknowledged" />
                </div>
              )}
              {queued !== null && (
                <div className="chat-queued-message" role="status" aria-label="Queued message">
                  <QueuedSent message={queued.text} />
                  <div className="chat-queued-footer">
                    <span>{queued.unkept ? "Not kept in this browser: leaving this chat or reloading loses it" : "Sends when this reply ends"}</span>
                    <button type="button" className="chat-queued-cancel" onClick={queued.cancel} aria-label="Cancel queued message">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        }}
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

/** The longest a chat may take to reach its latest message as it opens. */
const OPENING_MS = 1000;

/** Captures the first Enter keypress so the server-owned sidebar can refresh. */
function ChatThread({
  agent,
  threadId,
  accountId,
  turnRunning,
  turnMayRun,
  onMessageSubmitted,
  onTurnStarting,
  showWelcome,
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
  /** The account whose follow-ups this browser holds for the chat across a reload. */
  accountId: string | undefined;
  /** The chat's latest Turn runs, streaming here or on the server, so a follow-up waits for it to end. */
  turnRunning: boolean;
  /** Has the chat check with the server whether its Turn runs, as one this tab did not start may. */
  turnMayRun: () => void;
  onMessageSubmitted: () => void;
  onTurnStarting: (provider: string | undefined) => void;
  /** The account's models; until they load, a Turn would run on another account's model or the default. */
  models: ModelList;
  selectedModel: string | undefined;
  /** False while a sign-in has switched the account and the page has not rendered the new one's models. */
  isAccountCurrent: () => boolean;
  /** Stops the chat's Turn that runs on the server with no stream here, while one does. */
  stopServerTurn: (() => void) | null;
  /** Why the chat's latest Turn failed, as the Chat Service recorded it, for a page that did not stream it. */
  savedFailure: SavedTurnFailure | null;
  showWelcome: boolean;
  userName?: string | undefined;
  composerAccessory?: React.ReactNode;
  /** Called once as the chat opens, on the first frame it shows at its latest message. */
  onOpened: () => void;
  /** The message the chat opens at, when it holds it, rather than its latest. */
  openAt?: string | null;
  /** Opens a run's task Side Chat at the run, from its card. */
  onOpenRun?: (run: ReachedScheduledRun) => void;
  children?: React.ReactNode;
}) {
  const { copilotkit } = useCopilotKit();
  const openingAttempted = useRef(false);
  const firedRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), []);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useComposerResizesOnLayout(wrapperRef);
  const [opensAt] = useState(() => (openAt != null && agent.messages.some(({ id }) => id === openAt) ? openAt : null));
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (opensAt === null || wrapper === null) return undefined;
    return holdAtRow(wrapper, opensAt);
  },
  // Stryker disable next-line ArrayDeclaration: a chat opens at its message once, as it mounts
  []);
  // CopilotKit's scroll view reaches the latest message some frames after it mounts (#3697). The chat is open on the
  // first frame it shows there (or has nothing to scroll) with room made for its composer, or a second on, wherever it
  // shows: a chat that never comes to rest there, as a reply streams in, still opens.
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  useEffect(() => {
    const started = performance.now();
    let frame = requestAnimationFrame(function checkOpened(now) {
      const scroller = messagesScroller(wrapperRef.current);
      const atEnd = scroller === null || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((atEnd && hasComposerRoom(wrapperRef.current)) || now - started >= OPENING_MS) {
        onOpenedRef.current();
      } else {
        frame = requestAnimationFrame(checkOpened);
      }
    });
    return () => cancelAnimationFrame(frame);
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list checks once, from mount on
  []);
  // ADR 0030: a failed Turn shows why, until the next message is sent.
  const [runError, setRunError] = useState<TurnFailure | null>(null);
  const submittedQuestion = useRef<string | undefined>(undefined);
  // A Turn that failed with no page attached shows why once the chat opens on it.
  useEffect(() => {
    if (savedFailure !== null) setRunError(couldNotAnswer(savedFailure.message));
  }, [savedFailure]);
  // A Retry reads whether the account's models have loaded since the send it repeats.
  const accountRef = useRef({ models, isAccountCurrent, selectedModel });
  accountRef.current = { models, isAccountCurrent, selectedModel };
  const modelsReady = () => accountRef.current.isAccountCurrent() && accountRef.current.models.loaded;
  // A follow-up sent while a Turn runs is held here, and in this browser across a reload, then sent once the Turn
  // ends (#3920). Follow-ups sent meanwhile go together as one message.
  const [agentRunning, setAgentRunning] = useState(agent.isRunning);
  useEffect(() => {
    // Another agent for the chat, as when its Side Chat is chosen again, runs or not as it does.
    setAgentRunning(agent.isRunning);
    const subscription = agent.subscribe({
      onRunInitialized: () => setAgentRunning(true),
      onRunFinalized: () => setAgentRunning(false),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  const running = turnRunning || agentRunning;
  // Read from the agent, so a chat opened again mid-Turn knows its run has started.
  const subscribeRun = useCallback((listener: () => void) => {
    const subscription = agent.subscribe({ onRunStartedEvent: listener, onRunFinalized: listener });
    return () => subscription.unsubscribe();
  }, [agent]);
  const started = useSyncExternalStore(subscribeRun, () => runStarted(agent), () => false);
  // A follow-up waits out a lost connection too, held, rather than going to a Retry a reload would lose.
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    const selected = models.loaded ? models.models.find(({ key }) => key === selectedModel) : undefined;
    if (openingAttempted.current || !showWelcome || running || savedFailure !== null ||
        agent.messages.length !== 0 || !online || !isAccountCurrent() || !models.loaded ||
        models.accountId !== accountId || selected === undefined) return;
    openingAttempted.current = true;
    onTurnStarting(selected.provider);
    runningRef.current = true;
    setAgentRunning(true);
    const firstName = userName?.split(" ")[0];
    void (async () => {
      try {
        await copilotkit.runAgent({ agent, forwardedProps: { opening: true, ...(firstName ? { openingFirstName: firstName } : {}) } });
      } catch (error) {
        setRunError(couldNotAnswer(error instanceof Error ? error.message : String(error)));
      } finally {
        setAgentRunning(agent.isRunning);
      }
    })();
  }, [agent, accountId, showWelcome, running, savedFailure, online, models, selectedModel, userName, isAccountCurrent, copilotkit, onTurnStarting]);
  // A follow-up another tab holds may wait on a Turn that tab streams, which this one does not know of.
  const queued = useQueuedFollowUp(accountId, threadId, turnMayRun);
  const composerSubmit = useRef<Submit | null>(null);
  const submitTurn = (message: string, submit: Submit, retry?: () => void) => {
    if (runningRef.current) {
      queued.add(message);
      return true;
    }
    if (!modelsReady()) {
      const { models: accountModels } = accountRef.current;
      // Nothing loads the models again after a failure, so only a reload can.
      setRunError(
        !accountModels.loaded && accountModels.error !== null
          ? { message: `${accountModels.error}. Reload the page to send a message.` }
          : { message: "Your models are still loading. Send it again once they have.", retry: retry ?? (() => submitTurn(message, submit)) },
      );
      return false;
    }
    if (!navigator.onLine) {
      // No CopilotKit submit callback, message addition, or request has occurred: retry is safe.
      setRunError({ message: `Couldn't reach ${UI_CONFIG.title}. Check your connection.`, retry: retry ?? (() => submitTurn(message, submit)) });
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
  useEffect(() => {
    // Read when the lock is granted, so the browser's connection as it is then, not as last rendered.
    const ready = () => !runningRef.current && navigator.onLine && composerSubmit.current !== null && modelsReady();
    // Models that failed to load never send it; only a reload, which keeps it, can.
    if (!running && queued.text !== null && !models.loaded && models.error !== null) {
      setRunError({ message: `${models.error}. Reload the page to send your queued message.` });
      return;
    }
    if (!ready()) return;
    queued.send(ready, (text) => {
      if (composerSubmit.current !== null) submitTurn(text, composerSubmit.current);
    }, () => setRunError({ message: "Your queued message could not be taken out of this browser's storage, so it was not sent. Reload the page to try again." }));
  }, [running, online, queued.text, models]);
  useEffect(() => {
    // Keyboard and Send-button sends both add the user's message to the agent.
    const subscription = agent.subscribe({
      onNewMessage: ({ message }) => {
        if (message.role === "user") setRunError(null);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  // A chat opens with no files attached: page.tsx mounts a ChatThread for each chat.
  const attachedFiles = useComposerFiles(agentFiles.upload, accountId);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.shiftKey || !navigator.onLine || !modelsReady() || !attachedFiles.sendable) return;
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
      {showWelcome && !running && !openingAttempted.current && <WelcomeScreen userName={userName} />}
      <ToolCallRenderer agent={agent} />
      <SubmitTurn.Provider value={submitTurn}>
      <ComposerSubmit.Provider value={composerSubmit}>
      <ServerTurnStop.Provider value={stopServerTurn}>
      <ComposerAccessory.Provider value={composerAccessory}>
      <AttachedFiles.Provider value={attachedFiles}>
      <OpenScheduledRun.Provider value={onOpenRun ?? null}>
      <OpensAt.Provider value={opensAt}>
      <QueuedMessage.Provider value={queued.text === null ? null : {
        text: queued.text,
        unkept: queued.unkept,
        cancel: () => queued.cancel(() => setRunError({ message: "Your queued message could not be taken out of this browser's storage, so it was not cancelled. Reload the page to try again." })),
      }}>
        <RunError.Provider value={runError}>
        <RunStarted.Provider value={started}>
          <CopilotChat
            agentId={AGENT_ID}
            threadId={threadId}
            labels={{ chatInputPlaceholder: "Ask anything", chatDisclaimerText: UI_CONFIG.disclaimer, chatInputToolbarAddButtonLabel: "Add photos & files" }}
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
        </RunStarted.Provider>
        </RunError.Provider>
      </QueuedMessage.Provider>
      </OpensAt.Provider>
      </OpenScheduledRun.Provider>
      </AttachedFiles.Provider>
      </ComposerAccessory.Provider>
      </ServerTurnStop.Provider>
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
  useImperativeHandle(stopRef, () => ({ chatId, stop: () => {
    const agent = copilotkit.getAgent(AGENT_ID);
    if (agent) copilotkit.stopAgent({ agent });
  } }), [chatId, copilotkit]);
  return null;
}

export default function ChatSurface({ children, chatId, stopRef, ...props }: Omit<ComponentProps<typeof CopilotKit>, "children"> & {
  children: (Thread: typeof ChatThread) => ReactNode;
  chatId: string;
  stopRef?: Ref<ChatStop>;
}) {
  return <CopilotKit {...props}><ComputerStop chatId={chatId} stopRef={stopRef} />{children(ChatThread)}</CopilotKit>;
}
