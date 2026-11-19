"use client";

import { m as motionElement, resize } from "motion/react";
import { Presence, presenceMotion } from "./collapse";

import { useLayoutEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode, type RefObject } from "react";
import { contentToText, type Message } from "@ag-ui/client";
import { Plus } from "lucide-react";
import { Composer } from "./composer";
import { SentFileCards, sentFilesOf } from "./composer-files";
import { ThoughtStep, worklogRows } from "./worklog";
import { USER_MESSAGE_CLASS, fitBubbles } from "./bubble-width";
import { MAIN_CHAT_COPY_MESSAGE_LIMIT } from "./main-chat-copy";
import { OpenScheduledRun, ScheduledRunCard, scheduledRunOf, type ReachedScheduledRun } from "./scheduled-run-card";
import { CONVERSATION_THREAD, ConversationThread } from "./conversation-thread";

type MarkdownState = { status: "ready"; Renderer: ComponentType<{ text: string }>; prepare: (texts: string[]) => Promise<void> | null } | { status: "error"; error: Error };
let markdown: MarkdownState | undefined;
let pendingMarkdown: Promise<void> | undefined;
function loadMarkdown(): Promise<void> {
  return pendingMarkdown ??= import("./kept-markdown").then(
    (module) => { markdown = { status: "ready", Renderer: module.default, prepare: module.prepareKeptMarkdown }; },
    (error: Error) => { markdown = { status: "error", error }; },
  );
}
function readMarkdown() {
  if (markdown === undefined) throw loadMarkdown();
  if (markdown.status === "error") throw markdown.error;
  return markdown;
}

function isPlainAsciiParagraph(text: string) {
  return /^[\x20-\x7e]+$/.test(text) && text.trim() === text && !/[\\`*_${}[\]<>()#!|~&@+-]/.test(text)
    && !/^\d+\.\s/.test(text) && !/www\.|:\//i.test(text);
}

function needsMarkdown(messages: readonly Message[]) {
  return messages.some((message) => message.role === "assistant" && !isPlainAsciiParagraph(scheduledRunOf(message)?.text ?? contentToText(message.content)));
}


type KeptScrollerProps = { children: ReactNode; scroller: RefObject<HTMLElement | null> };

function KeptThread({ children, scroller }: KeptScrollerProps) {
  return (
    <ConversationThread className="kept-chat-thread" page={false} opensAt={null} contextRef={(context) => { scroller.current = context?.scrollRef.current ?? null; }}>
      {children}
    </ConversationThread>
  );
}

function KeptBox({ children, scroller }: KeptScrollerProps) {
  return (
    <div className="cpk:flex-1 cpk:max-h-full cpk:flex cpk:flex-col cpk:min-h-0">
      <div ref={(element) => { scroller.current = element; }} style={{ height: "100%", width: "100%", scrollbarGutter: "stable both-edges", overflow: "auto" }}>
        {children}
      </div>
    </div>
  );
}

const KeptScroller = CONVERSATION_THREAD ? KeptThread : KeptBox;

export function preloadKeptChat(messages: readonly Message[]) {
  if (needsMarkdown(messages.slice(-MAIN_CHAT_COPY_MESSAGE_LIMIT))) void loadMarkdown();
}

export function prepareKeptChat(messages: readonly Message[]): Promise<void> | null {
  const kept = messages.slice(-MAIN_CHAT_COPY_MESSAGE_LIMIT);
  if (!needsMarkdown(kept)) return null;
  const texts = kept.filter((message) => message.role === "assistant")
    .map((message) => scheduledRunOf(message)?.text ?? contentToText(message.content));
  const prepare = () => readMarkdown().prepare(texts);
  return markdown === undefined ? loadMarkdown().then(() => prepare() ?? undefined) : prepare();
}

function KeptReply({ text }: { text: string }) {
  if (isPlainAsciiParagraph(text)) return <div className="space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"><p>{text}</p></div>;
  const Formatted = readMarkdown().Renderer;
  return <Formatted text={text} />;
}

/** CopilotKit's side padding around the messages and the composer, inside the chat's container. */
const COLUMN_PADDING = "cpk:px-4 cpk:@3xl:px-0 cpk:[div[data-sidebar-chat]_&]:px-8 cpk:[div[data-popup-chat]_&]:px-6";

function keptRow(message: Message, running: boolean, latest: boolean): ReactElement | null {
  switch (message.role) {
    case "user": {
      const { text, paths } = sentFilesOf(contentToText(message.content));
      return (
        <div data-copilotkit className="copilotKitMessage copilotKitUserMessage cpk:flex cpk:flex-col cpk:items-end cpk:group cpk:pt-10" key={message.id}>
          <SentFileCards paths={paths} />
          <Presence>{text && (
            <motionElement.div {...presenceMotion} className={USER_MESSAGE_CLASS}>
              {text}
            </motionElement.div>
          )}</Presence>
        </div>
      );
    }
    case "assistant": {
      const run = scheduledRunOf(message);
      if (run !== null) return (
        <div key={message.id} data-message-id={message.id}>
          <ScheduledRunCard run={run}>
            <KeptReply text={run.text} />
          </ScheduledRunCard>
        </div>
      );
      return (
        <div data-copilotkit className="copilotKitMessage copilotKitAssistantMessage" key={message.id}>
          <div className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert">
            <KeptReply text={contentToText(message.content)} />
          </div>
        </div>
      );
    }
    case "reasoning":
      return <ThoughtStep key={message.id} message={message} isRunning={running} isLatest={latest} />;
    default:
      return null;
  }
}

function questionAtOrBefore(messages: readonly Message[], index: number): number {
  return Math.max(0, messages.findLastIndex((message, i) => i <= index && message.role === "user"));
}

const ignore = () => {};

export function KeptChat({ messages, running = false, disclaimer, composerAccessory, latestShown, onOpenRun }: { messages: Message[]; running?: boolean; disclaimer: string; composerAccessory?: ReactNode; latestShown?: RefObject<number>; onOpenRun?: (run: ReachedScheduledRun) => void }) {
  const kept = messages.slice(-MAIN_CHAT_COPY_MESSAGE_LIMIT);
  if (needsMarkdown(kept)) readMarkdown();
  // Only the latest Turns that overflow the screen are formatted before the history's first frame. The copy
  // that replaces the Suspense fallback's starts where that one grew to.
  const [formatted, setFormatted] = useState(() => latestShown?.current ?? 1);
  const from = questionAtOrBefore(kept, kept.length - formatted);
  const scroller = useRef<HTMLElement | null>(null);
  const composer = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);

  // As CopilotChatView: the scroll content ends the composer's height, plus 32px, below the last message. Set on the
  // content itself: the kept Main Chat that replaces the Suspense fallback's as the chat surface mounts took that height
  // through a re-render that came only after the chat had opened, the kept messages that height below a phone's.
  useLayoutEffect(() => {
    const element = composer.current;
    const content = room.current;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: the refs hold the composer and content once mounted
    if (element === null || content === null) return undefined;
    const measure = () => {
      content.style.paddingBottom = `${element.offsetHeight + 32}px`;
    };
    measure();
    return resize([element], measure);
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list measures from mount on
  []);

  // use-stick-to-bottom defers resize following by a frame; saved history must stay at its end on every paint.
  useLayoutEffect(() => {
    if (CONVERSATION_THREAD) return undefined;
    const element = scroller.current;
    // Stryker disable next-line OptionalChaining: the ref holds the scroller once mounted
    const content = element?.firstElementChild;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral: the scroller and its content are mounted
    if (!element || !content) return undefined;
    const toEnd = () => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 1;
    };
    toEnd();
    return resize([content], toEnd);
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list scrolls from mount on
  []);

  const growUntilOverflow = useRef(() => {});
  growUntilOverflow.current = () => {
    const element = scroller.current;
    if (element === null || from === 0 || element.scrollHeight - element.clientHeight > 1) return;
    const next = kept.length - questionAtOrBefore(kept, from - 1);
    if (latestShown) latestShown.current = next;
    setFormatted(next);
  };
  useLayoutEffect(() => growUntilOverflow.current());
  useLayoutEffect(() => {
    const element = scroller.current;
    // Stryker disable next-line ConditionalExpression: the ref holds the scroller once mounted
    if (element === null) return undefined;
    return resize([element], () => growUntilOverflow.current());
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list observes from mount on
  []);

  const column = (
    <div className="cpk:overflow-y-auto cpk:overflow-x-hidden" style={{ flex: "1 1 0%", minHeight: 0 }}>
      <div className={COLUMN_PADDING}>
        <div ref={room} style={{ paddingBottom: "32px" }}>
          <div className="cpk:max-w-3xl cpk:mx-auto">
            <div ref={fitBubbles} data-copilotkit className="copilotKitMessages cpk:flex cpk:flex-col">
              {worklogRows(kept.slice(from).map((message) => keptRow(message, running, message.id === kept.at(-1)?.id)).filter((row) => row !== null), messages, running, { rendering: "saved" })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <OpenScheduledRun.Provider value={onOpenRun ?? null}>
    <div className="chat-wrapper">
      <div data-copilotkit className="copilotKitChat cpk:@container cpk:relative cpk:h-full cpk:flex cpk:flex-col chat-full-height">
        <KeptScroller scroller={scroller}>{column}</KeptScroller>
        <div ref={composer} className="kept-chat-composer cpk:absolute cpk:bottom-0 cpk:left-0 cpk:right-0 cpk:z-20 cpk:pointer-events-none">
          <Presence>{composerAccessory && (
            <motionElement.div {...presenceMotion} className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:@3xl:px-0">
              <div className="composer-accessory">{composerAccessory}</div>
            </motionElement.div>
          )}</Presence>
          <div inert aria-hidden>
            <Composer
              value=""
              onChange={ignore}
              onSend={ignore}
              onStop={undefined}
              running={false}
              canSend={false}
              hasFiles={false}
              addMenu={<button type="button" className="composer-add" data-testid="copilot-add-menu-button" aria-label="Add photos & files"><Plus size={20} aria-hidden /></button>}
              disclaimer={disclaimer}
              replica
            />
          </div>
        </div>
      </div>
    </div>
    </OpenScheduledRun.Provider>
  );
}
