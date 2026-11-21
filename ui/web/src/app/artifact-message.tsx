import { CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { useMessageEntrance } from "./message-entrance";
import { Message, MessageContent } from "@/components/ui/message";
import { useContext, useState, type ComponentPropsWithRef, type ReactNode } from "react";

import { ArtifactCard } from "./artifact-panel";
import { AnswerCards, AnswerTurn, type Published } from "./artifact-published";

import MarkdownRenderer, { StockMarkdownRenderer } from "./markdown-renderer";
import { ReplyFileSlot } from "./reply-file-card";

const MotionMessage = m.create(Message);
const MotionAssistantMessage = m.create(function AssistantMessageRoot({ sdkProps, style, ref }: { sdkProps: CopilotChatAssistantMessageProps } & Pick<ComponentPropsWithRef<"div">, "style" | "ref">) {
  const rootProps = { ...sdkProps, style: { ...sdkProps.style, ...style }, ref };
  return <CopilotChatAssistantMessage {...rootProps} />;
});

/** A reply that calls tools: stock Message has no tool-call view, so CopilotKit's renders its Worklog steps. */
function ToolMessage(props: CopilotChatAssistantMessageProps) {
  const entrance = useMessageEntrance(props.message.id, { hasContent: hasWords(props.message) });
  return <LazyMotion features={domAnimation} strict><AnimatePresence><MotionAssistantMessage sdkProps={{ ...props, markdownRenderer: MARKDOWN }} {...entrance} /></AnimatePresence></LazyMotion>;
}

function PlainMessage(props: CopilotChatAssistantMessageProps & { "data-bubble-ends"?: string | undefined }) {
  const entrance = useMessageEntrance(props.message.id, { hasContent: hasWords(props.message) });
  return <LazyMotion features={domAnimation} strict><AnimatePresence><MotionMessage from="assistant" className="chat-message" data-message-id={props.message.id} data-bubble-ends={props["data-bubble-ends"]} {...entrance}>
    <MessageContent className="chat-bubble"><StockMarkdownRenderer content={typeof props.message.content === "string" ? props.message.content : ""} /></MessageContent>
  </MotionMessage></AnimatePresence></LazyMotion>;
}

const MARKDOWN = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;
const hasWords = ({ content }: CopilotChatAssistantMessageProps["message"]) => typeof content === "string" && content.trim() !== "";

/** One bubble: the answer's words, then the cards of the Artifacts its Turn published, then its Files. */
export function ArtifactMessage(props: CopilotChatAssistantMessageProps) {
  const cards = useContext(AnswerCards);
  const turn = useContext(AnswerTurn);
  if (turn.id === "" && cards.length === 0 && !props.message.toolCalls?.some(({ function: call }) => call.name === "Artifact")) {
    return props.message.toolCalls?.length ? <ToolMessage {...props} /> : <PlainMessage {...props} data-bubble-ends={hasWords(props.message) ? "" : undefined} />;
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
          <div data-artifact-turn={turn.id} data-artifact-stage={turn.stage} data-artifact-answer={props.message.toolCalls?.length ? undefined : ""} className="artifact-reply-bubble [&>.chat-markdown:not(:empty):has(+div:not(:empty))]:mb-4">
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
