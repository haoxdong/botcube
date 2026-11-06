"use client";

import { m as motionElement } from "framer-motion";

import { Presence, presenceMotion } from "./collapse";

import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { contentToText, type Message } from "@ag-ui/client";
import { ArrowUp, Plus } from "lucide-react";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";
import { rehypeReplyFiles } from "./reply-file-path";
import { REPLY_MARKDOWN } from "./reply-markdown";
import { SentFileCards, sentFilesOf } from "./composer-files";
import { worklogRows } from "./worklog";
import { USER_MESSAGE_CLASS, fitBubbles } from "./bubble-width";
import { MAIN_CHAT_COPY_MESSAGE_LIMIT } from "./main-chat-copy";
import { OpenScheduledRun, ScheduledRunCard, scheduledRunOf, type ReachedScheduledRun } from "./scheduled-run-card";

/**
 * Streamdown's own rehype plugins, with rehypeReplyFiles where the chat surface runs it (before harden, the last), so a
 * file a reply links to shows as the same card from the first frame.
 */
const KEPT_REHYPE_PLUGINS = Object.values(defaultRehypePlugins).toSpliced(-1, 0, rehypeReplyFiles);

/** CopilotKit's side padding around the messages and the composer, inside the chat's container. */
const COLUMN_PADDING = "cpk:px-4 cpk:@3xl:px-0 cpk:[div[data-sidebar-chat]_&]:px-8 cpk:[div[data-popup-chat]_&]:px-6";

function keptRow(message: Message): ReactElement | null {
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
            <Streamdown {...REPLY_MARKDOWN} rehypePlugins={KEPT_REHYPE_PLUGINS} remarkPlugins={[...Object.values(defaultRemarkPlugins), [remarkRepairedBracketMath, run.text]]}>{run.text}</Streamdown>
          </ScheduledRunCard>
        </div>
      );
      return (
        <div data-copilotkit className="copilotKitMessage copilotKitAssistantMessage" key={message.id}>
          <div className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert">
            <Streamdown {...REPLY_MARKDOWN} rehypePlugins={KEPT_REHYPE_PLUGINS} remarkPlugins={[...Object.values(defaultRemarkPlugins), [remarkRepairedBracketMath, contentToText(message.content)]]}>
              {contentToText(message.content)}
            </Streamdown>
          </div>
        </div>
      );
    }
    case "reasoning":
      return <div key={message.id} />;
    default:
      return null;
  }
}

function questionAtOrBefore(messages: readonly Message[], index: number): number {
  return Math.max(0, messages.findLastIndex((message, i) => i <= index && message.role === "user"));
}

export function KeptChat({ messages, running = false, disclaimer, composerAccessory, latestShown, onOpenRun }: { messages: Message[]; running?: boolean; disclaimer: string; composerAccessory?: ReactNode; latestShown?: RefObject<number>; onOpenRun?: (run: ReachedScheduledRun) => void }) {
  const kept = messages.slice(-MAIN_CHAT_COPY_MESSAGE_LIMIT);
  // Only the latest Turns that overflow the screen are formatted before the history's first frame. The copy
  // that replaces the Suspense fallback's starts where that one grew to.
  const [formatted, setFormatted] = useState(() => latestShown?.current ?? 1);
  const from = questionAtOrBefore(kept, kept.length - formatted);
  const scroller = useRef<HTMLDivElement>(null);
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
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list measures from mount on
  []);

  // As the chat surface's scroll view at either width (use-stick-to-bottom's end): 1px short of its latest message,
  // and kept there, so the latest message is where the chat surface shows it.
  useLayoutEffect(() => {
    const element = scroller.current;
    // Stryker disable next-line OptionalChaining: the ref holds the scroller once mounted
    const content = element?.firstElementChild;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral: the scroller and its content are mounted
    if (!element || !content) return undefined;
    const toEnd = () => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 1;
    };
    toEnd();
    const observer = new ResizeObserver(toEnd);
    observer.observe(content);
    return () => observer.disconnect();
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
    const observer = new ResizeObserver(() => growUntilOverflow.current());
    observer.observe(element);
    return () => observer.disconnect();
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list observes from mount on
  []);

  return (
    <OpenScheduledRun.Provider value={onOpenRun ?? null}>
    <div className="chat-wrapper">
      <div data-copilotkit className="copilotKitChat cpk:@container cpk:relative cpk:h-full cpk:flex cpk:flex-col chat-full-height">
        <div className="cpk:flex-1 cpk:max-h-full cpk:flex cpk:flex-col cpk:min-h-0">
          <div ref={scroller} style={{ height: "100%", width: "100%", scrollbarGutter: "stable both-edges", overflow: "auto" }}>
            <div className="cpk:overflow-y-auto cpk:overflow-x-hidden" style={{ flex: "1 1 0%", minHeight: 0 }}>
              <div className={COLUMN_PADDING}>
                <div ref={room} style={{ paddingBottom: "32px" }}>
                  <div className="cpk:max-w-3xl cpk:mx-auto">
                    <div ref={fitBubbles} data-copilotkit className="copilotKitMessages cpk:flex cpk:flex-col">
                      {worklogRows(kept.slice(from).map(keptRow).filter((row) => row !== null), messages, running)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div ref={composer} className="kept-chat-composer cpk:absolute cpk:bottom-0 cpk:left-0 cpk:right-0 cpk:z-20 cpk:pointer-events-none">
          <Presence>{composerAccessory && (
            <motionElement.div {...presenceMotion} className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:sm:px-0">
              <div className="composer-accessory">{composerAccessory}</div>
            </motionElement.div>
          )}</Presence>
          <div data-copilotkit className="cpk:pointer-events-none cpk:relative cpk:z-20 composer-can-attach" style={{ paddingBottom: "var(--copilotkit-license-banner-offset, 0px)" }}>
            <div className="cpk:max-w-3xl cpk:mx-auto cpk:py-0 cpk:px-4 cpk:@3xl:px-0 cpk:[div[data-sidebar-chat]_&]:px-8 cpk:[div[data-popup-chat]_&]:px-4 cpk:pointer-events-auto">
              <div inert aria-hidden style={{ visibility: "visible" }} className="copilotKitInput cpk:flex cpk:w-full cpk:flex-col cpk:items-center cpk:justify-center cpk:cursor-text cpk:overflow-visible cpk:bg-clip-padding cpk:contain-inline-size cpk:rounded-[28px]" data-layout="compact">
                <div className="cpk:grid cpk:w-full cpk:gap-x-3 cpk:gap-y-3 cpk:px-3 cpk:py-2 cpk:grid-cols-[auto_minmax(0,1fr)_auto] cpk:items-center" data-layout="compact">
                  <div className="cpk:flex cpk:items-center cpk:row-start-1 cpk:col-start-1">
                    <button type="button" data-testid="copilot-add-menu-button" aria-label="Add photos & files"><Plus size={20} aria-hidden /></button>
                  </div>
                  <div className="cpk:relative cpk:flex cpk:min-w-0 cpk:flex-col cpk:min-h-[50px] cpk:justify-center cpk:col-start-2 cpk:row-start-1">
                    <textarea data-testid="copilot-chat-textarea" placeholder="Ask anything" readOnly rows={1} className="cpk:bg-transparent cpk:outline-none cpk:antialiased cpk:font-regular cpk:text-[16px] cpk:w-full cpk:py-3 cpk:pr-5" style={{ overflow: "auto", resize: "none", maxHeight: 106 }} />
                  </div>
                  <div className="cpk:flex cpk:items-center cpk:justify-end cpk:gap-2 cpk:col-start-3 cpk:row-start-1">
                    <div className="cpk:mr-[10px]">
                      <button type="button" data-testid="copilot-send-button" aria-label="Send" disabled className="cpk:inline-flex cpk:items-center cpk:justify-center cpk:shrink-0 cpk:rounded-full cpk:h-9 cpk:w-9 cpk:disabled:opacity-50">
                        <ArrowUp className="cpk:size-[18px]" aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="chat-disclaimer cpk:text-center cpk:py-3 cpk:px-4 cpk:max-w-3xl cpk:mx-auto">{disclaimer}</div>
          </div>
        </div>
      </div>
    </div>
    </OpenScheduledRun.Provider>
  );
}
