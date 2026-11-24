import { CopilotChatToolCallsView, type CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { useMessageEntrance } from "./message-entrance";
import { Rises } from "./motion";
import { Message, MessageContent } from "@/components/ui/message";
import { useContext, useState } from "react";

import { ArtifactCard } from "./artifact-panel";
import { AnswerCards, AnswerTurn, type Published } from "./artifact-published";

import MarkdownRenderer from "./markdown-renderer";
import { ReplyFileSlot } from "./reply-file-card";

const wordsOf = ({ content }: CopilotChatAssistantMessageProps["message"]) => (typeof content === "string" ? content : "");
const hasWords = (message: CopilotChatAssistantMessageProps["message"]) => wordsOf(message).trim() !== "";

/** A reply that calls tools: its words in the one bubble, then CopilotKit's tool-call view, which renders its Worklog steps. */
function ToolMessage(props: CopilotChatAssistantMessageProps) {
  const entrance = useMessageEntrance(props.message.id, { hasContent: hasWords(props.message) });
  return <Rises {...entrance}><Message from="assistant" className="chat-message" data-message-id={props.message.id}>
    {hasWords(props.message) && <MessageContent className="chat-bubble"><MarkdownRenderer content={wordsOf(props.message)} /></MessageContent>}
    <CopilotChatToolCallsView message={props.message} {...(props.messages ? { messages: props.messages } : {})} />
  </Message></Rises>;
}

function PlainMessage(props: CopilotChatAssistantMessageProps & { "data-bubble-ends"?: string | undefined }) {
  const entrance = useMessageEntrance(props.message.id, { hasContent: hasWords(props.message) });
  return <Rises {...entrance}><Message from="assistant" className="chat-message" data-message-id={props.message.id} data-bubble-ends={props["data-bubble-ends"]}>
    {hasWords(props.message) && <MessageContent className="chat-bubble"><MarkdownRenderer content={wordsOf(props.message)} /></MessageContent>}
  </Message></Rises>;
}

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
  return <Rises {...entrance}><Message from="assistant" className="chat-message" data-message-id={props.message.id}>
    <MessageContent data-artifact-turn={turn.id} data-artifact-stage={turn.stage} data-artifact-answer={props.message.toolCalls?.length ? undefined : ""} className="chat-bubble artifact-reply-bubble [&>.chat-markdown:not(:empty):has(+div:not(:empty))]:mb-4">
      <ArtifactReply {...props} cards={cards} />
    </MessageContent>
  </Message></Rises>;
}

function ArtifactReply({ message, messages, cards }: CopilotChatAssistantMessageProps & { cards: readonly Published[] }) {
  const [files, setFiles] = useState<HTMLDivElement | null>(null);
  return <ReplyFileSlot.Provider value={files}>
    <MarkdownRenderer content={wordsOf(message)} />
    <div className="flex flex-wrap gap-2">{cards.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}<CopilotChatToolCallsView message={message} {...(messages ? { messages } : {})} /></div>
    <div ref={setFiles} className="mt-4 empty:hidden [&>.reply-file:last-child]:mb-0" />
  </ReplyFileSlot.Provider>;
}

export const ARTIFACT_MESSAGE = ArtifactMessage as typeof CopilotChatAssistantMessage;
