import { CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";

import MarkdownRenderer from "./markdown-renderer";

const MARKDOWN = ({ content }: { content: string }) => <MarkdownRenderer content={content} />;

export function ArtifactMessage(props: CopilotChatAssistantMessageProps) {
  if (!props.message.toolCalls?.some(({ function: call }) => call.name === "Artifact")) {
    return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN} />;
  }
  return <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN}>
    {({ markdownRenderer, toolCallsView, toolbar, toolbarVisible }) => (
      <div className="copilotKitMessage copilotKitAssistantMessage" data-message-id={props.message.id}>
        <div className="cpk:prose">
          <div className="artifact-reply-bubble">
            {markdownRenderer}
            <div className="flex flex-wrap gap-2">{toolCallsView}</div>
          </div>
        </div>
        {toolbarVisible && toolbar}
      </div>
    )}
  </CopilotChatAssistantMessage>;
}

export const ARTIFACT_MESSAGE = ArtifactMessage as typeof CopilotChatAssistantMessage;
