import { CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { useState, type ReactNode } from "react";

import MarkdownRenderer from "./markdown-renderer";
import { ReplyFileSlot } from "./reply-file-card";

const MARKDOWN = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;

export function ArtifactMessage(props: CopilotChatAssistantMessageProps) {
  if (!props.message.toolCalls?.some(({ function: call }) => call.name === "Artifact")) {
    return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN} />;
  }
  return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN}>
    {({ markdownRenderer, toolCallsView, toolbar, toolbarVisible }) => (
      <div className="copilotKitMessage copilotKitAssistantMessage" data-message-id={props.message.id}>
        <div className="cpk:prose">
          <div className="artifact-reply-bubble [&>.chat-markdown:not(:empty)]:mb-4">
            <ArtifactReply markdown={markdownRenderer} tools={toolCallsView} />
          </div>
        </div>
        {toolbarVisible && toolbar}
      </div>
    )}
  </CopilotChatAssistantMessage>;
}

function ArtifactReply({ markdown, tools }: { markdown: ReactNode; tools: ReactNode }) {
  const [files, setFiles] = useState<HTMLDivElement | null>(null);
  return <ReplyFileSlot.Provider value={files}>
    {markdown}
    <div className="flex flex-wrap gap-2">{tools}</div>
    <div ref={setFiles} className="mt-4 empty:hidden [&>.reply-file:last-child]:mb-0" />
  </ReplyFileSlot.Provider>;
}

export const ARTIFACT_MESSAGE = ArtifactMessage as typeof CopilotChatAssistantMessage;
