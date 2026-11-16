import { CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { useContext, useState, type ReactNode } from "react";

import { ArtifactCard } from "./artifact-panel";
import { AnswerCards, type Published } from "./artifact-published";

import MarkdownRenderer from "./markdown-renderer";
import { ReplyFileSlot } from "./reply-file-card";

const MARKDOWN = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;

/** One bubble: the answer's words, then the cards of the Artifacts its Turn published, then its Files. */
export function ArtifactMessage(props: CopilotChatAssistantMessageProps) {
  const cards = useContext(AnswerCards);
  if (cards.length === 0 && !props.message.toolCalls?.some(({ function: call }) => call.name === "Artifact")) {
    return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN} />;
  }
  return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN}>
    {({ markdownRenderer, toolCallsView, toolbar, toolbarVisible }) => (
      <div className="copilotKitMessage copilotKitAssistantMessage" data-message-id={props.message.id}>
        <div className="cpk:prose">
          <div className="artifact-reply-bubble [&>.chat-markdown:not(:empty)]:mb-4">
            <ArtifactReply markdown={markdownRenderer} tools={toolCallsView} cards={cards} />
          </div>
        </div>
        {toolbarVisible && toolbar}
      </div>
    )}
  </CopilotChatAssistantMessage>;
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
