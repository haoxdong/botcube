import { CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { useMessageEntrance } from "./message-entrance";
import { useContext, useState, type ComponentPropsWithRef, type ReactNode } from "react";

import { ArtifactCard } from "./artifact-panel";
import { AnswerCards, AnswerTurn, type Published } from "./artifact-published";

import MarkdownRenderer from "./markdown-renderer";
import { ReplyFileSlot } from "./reply-file-card";

const MotionAssistantMessage = m.create(function AssistantMessageRoot({ sdkProps, style, ref }: { sdkProps: CopilotChatAssistantMessageProps } & Pick<ComponentPropsWithRef<"div">, "style" | "ref">) {
  const rootProps = { ...sdkProps, style: { ...sdkProps.style, ...style }, ref };
  return <CopilotChatAssistantMessage {...rootProps} />;
});

function PlainMessage(props: CopilotChatAssistantMessageProps) {
  const entrance = useMessageEntrance(props.message.id, { hasContent: hasWords(props.message) });
  return <LazyMotion features={domAnimation} strict><AnimatePresence><MotionAssistantMessage sdkProps={{ ...props, markdownRenderer: MARKDOWN }} {...entrance} /></AnimatePresence></LazyMotion>;
}

const MARKDOWN = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;
const hasWords = ({ content }: CopilotChatAssistantMessageProps["message"]) => typeof content === "string" && content.trim() !== "";

/** Marq's row ends at a bubble with words in it when no tool row follows the words: chat.css joins the next reply to it. */
const endsAtBubble = (message: CopilotChatAssistantMessageProps["message"]) =>
  hasWords(message) && !message.toolCalls?.length;

/** One bubble: the answer's words, then the cards of the Artifacts its Turn published, then its Files. */
export function ArtifactMessage(props: CopilotChatAssistantMessageProps) {
  const cards = useContext(AnswerCards);
  if (cards.length === 0 && !props.message.toolCalls?.some(({ function: call }) => call.name === "Artifact")) {
    return <PlainMessage {...props} data-bubble-ends={endsAtBubble(props.message) ? "" : undefined} />;
  }
  return <ArtifactRoot {...props} />;
}

function ArtifactRoot(props: CopilotChatAssistantMessageProps) {
  const cards = useContext(AnswerCards);
  const turn = useContext(AnswerTurn);
  const entrance = useMessageEntrance(props.message.id, { artifacts: cards.map(({ id }) => JSON.stringify([turn.id, id])), answer: !props.message.toolCalls?.length, hasContent: cards.length > 0 || hasWords(props.message) });
  return <LazyMotion features={domAnimation} strict><AnimatePresence><CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN}>
    {({ markdownRenderer, toolCallsView, toolbar, toolbarVisible }) => (
      <m.div {...entrance} className="copilotKitMessage copilotKitAssistantMessage" data-message-id={props.message.id}>
        <div className="cpk:prose">
          <div data-artifact-turn={turn.id} data-artifact-stage={turn.stage} data-artifact-answer={props.message.toolCalls?.length ? undefined : ""} className="artifact-reply-bubble [&>.chat-markdown:not(:empty)]:mb-4">
            <ArtifactReply markdown={markdownRenderer} tools={toolCallsView} cards={cards} />
          </div>
        </div>
        {toolbarVisible && toolbar}
      </m.div>
    )}
  </CopilotChatAssistantMessage></AnimatePresence></LazyMotion>;
}

function ArtifactReply({ markdown, tools, cards }: { markdown: ReactNode; tools: ReactNode; cards: readonly Published[] }) {
  const [files, setFiles] = useState<HTMLDivElement | null>(null);
  return <ReplyFileSlot.Provider value={files}>
    {markdown}
    <div className="flex flex-wrap gap-2">{cards.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}{tools}</div>
    <div ref={setFiles} className="mt-4 empty:hidden [&>.reply-file:last-child]:mb-0" />
  </ReplyFileSlot.Provider>;
}

export const ARTIFACT_MESSAGE = ArtifactMessage as typeof CopilotChatAssistantMessage;
