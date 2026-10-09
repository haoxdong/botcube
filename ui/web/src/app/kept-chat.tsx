"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { contentToText, type Message } from "@ag-ui/client";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";

/** CopilotKit's side padding around the messages and the composer, inside the chat's container. */
const COLUMN_PADDING = "cpk:px-4 cpk:@3xl:px-0 cpk:[div[data-sidebar-chat]_&]:px-8 cpk:[div[data-popup-chat]_&]:px-6";

/**
 * The kept Main Chat while the chat surface loads (#3697), laid out as the chat surface lays it out so that nothing on
 * screen moves when it takes over: its question bubbles, its replies formatted, its padding, its composer's room, and
 * opened at its latest message. The markup copies CopilotKit 1.77's CopilotChatView, CopilotChatUserMessage and
 * CopilotChatInput (the composer's box stays hidden, as it is until the chat surface places its model picker);
 * `scripts/web-cold-open-check.mjs` fails when a kept message moves as the chat surface takes over. A reply shows
 * through Streamdown without the chat surface's plugins, which load with it.
 */
export function KeptChat({ messages, disclaimer, composerAccessory }: { messages: Message[]; disclaimer: string; composerAccessory?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);

  // As CopilotChatView: the scroll content ends the composer's height, plus 32px, below the last message. Set on the
  // content itself: the kept Main Chat that replaces the Suspense fallback's as the chat surface mounts took that height
  // through a re-render that came only after the chat had opened, the kept messages that height below a phone's (#3697).
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

  // As the chat surface's scroll view (initial and resize "instant"): at its latest message, and kept there.
  useLayoutEffect(() => {
    const element = scroller.current;
    // Stryker disable next-line OptionalChaining: the ref holds the scroller once mounted
    const content = element?.firstElementChild;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral: the scroller and its content are mounted
    if (!element || !content) return undefined;
    const toEnd = () => { element.scrollTop = element.scrollHeight; };
    toEnd();
    const observer = new ResizeObserver(toEnd);
    observer.observe(content);
    return () => observer.disconnect();
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list scrolls from mount on
  []);

  return (
    <div className="chat-wrapper">
      <div data-copilotkit className="copilotKitChat cpk:@container cpk:relative cpk:h-full cpk:flex cpk:flex-col chat-full-height">
        <div className="cpk:flex-1 cpk:max-h-full cpk:flex cpk:flex-col cpk:min-h-0">
          <div ref={scroller} style={{ height: "100%", width: "100%", scrollbarGutter: "stable both-edges", overflow: "auto" }}>
            <div className="cpk:overflow-y-auto cpk:overflow-x-hidden" style={{ flex: "1 1 0%", minHeight: 0 }}>
              <div className={COLUMN_PADDING}>
                <div ref={room} style={{ paddingBottom: "32px" }}>
                  <div className="cpk:max-w-3xl cpk:mx-auto">
                    <div data-copilotkit className="copilotKitMessages cpk:flex cpk:flex-col">
                      {messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) =>
                        message.role === "user" ? (
                          <div data-copilotkit className="copilotKitMessage copilotKitUserMessage cpk:flex cpk:flex-col cpk:items-end cpk:group cpk:pt-10" key={message.id}>
                            <div className="cpk:prose cpk:dark:prose-invert cpk:bg-muted cpk:relative cpk:max-w-[80%] cpk:rounded-[18px] cpk:px-4 cpk:py-1.5 cpk:data-[multiline]:py-3 cpk:inline-block cpk:whitespace-pre-wrap">
                              {contentToText(message.content)}
                            </div>
                          </div>
                        ) : (
                          <div data-copilotkit className="copilotKitMessage copilotKitAssistantMessage" key={message.id}>
                            <div className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert">
                              <Streamdown remarkPlugins={[...Object.values(defaultRemarkPlugins), [remarkRepairedBracketMath, contentToText(message.content)]]}>
                                {contentToText(message.content)}
                              </Streamdown>
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div ref={composer} className="cpk:absolute cpk:bottom-0 cpk:left-0 cpk:right-0 cpk:z-20 cpk:pointer-events-none">
          {composerAccessory && (
            <div className="cpk:max-w-3xl cpk:mx-auto cpk:px-4 cpk:sm:px-0">
              <div className="composer-accessory">{composerAccessory}</div>
            </div>
          )}
          <div data-copilotkit className="cpk:pointer-events-none cpk:relative cpk:z-20" style={{ paddingBottom: "var(--copilotkit-license-banner-offset, 0px)" }}>
            <div className="cpk:max-w-3xl cpk:mx-auto cpk:py-0 cpk:px-4 cpk:@3xl:px-0 cpk:[div[data-sidebar-chat]_&]:px-8 cpk:[div[data-popup-chat]_&]:px-4 cpk:pointer-events-auto">
              <div className="copilotKitInput cpk:flex cpk:w-full cpk:flex-col cpk:items-center cpk:justify-center cpk:overflow-visible cpk:bg-clip-padding cpk:contain-inline-size cpk:bg-white cpk:dark:bg-[#303030] cpk:shadow-[0_4px_4px_0_#0000000a,0_0_1px_0_#0000009e] cpk:rounded-[28px]" data-layout="expanded">
                <div className="cpk:grid cpk:w-full cpk:gap-x-3 cpk:gap-y-3 cpk:px-3 cpk:py-2 cpk:grid-cols-[auto_minmax(0,1fr)_auto] cpk:grid-rows-[auto_auto]" data-layout="expanded">
                  <div className="cpk:flex cpk:items-center cpk:row-start-2 cpk:col-start-1" />
                  <div className="cpk:relative cpk:flex cpk:min-w-0 cpk:flex-col cpk:min-h-[50px] cpk:justify-center cpk:col-span-3 cpk:row-start-1" />
                  <div className="cpk:flex cpk:items-center cpk:justify-end cpk:gap-2 cpk:col-start-3 cpk:row-start-2" />
                </div>
              </div>
            </div>
            <div className="cpk:text-center cpk:text-xs cpk:text-muted-foreground cpk:py-3 cpk:px-4 cpk:max-w-3xl cpk:mx-auto">{disclaimer}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
