"use client";

import { CopilotChatUserMessage, type CopilotChatAssistantMessageProps, type CopilotChatUserMessageProps } from "@copilotkit/react-core/v2";
import { Message, MessageContent } from "@/components/ui/message";
import { agentFiles } from "./agent-files";
import { SentFileCards, sentFilesOf } from "./composer-files";
import { Fades, Rises } from "./motion";
import { useMessageEntrance } from "./message-entrance";
import { ArtifactMessage } from "./artifact-message";
import MarkdownRenderer from "./markdown-renderer";
import { ScheduledRunCard, scheduledRunOf } from "./scheduled-run-card";

export function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const run = scheduledRunOf(props.message);
  if (run !== null) return <div data-message-id={props.message.id}><ScheduledRunCard run={run}><MarkdownRenderer content={run.text} /></ScheduledRunCard></div>;
  return <ArtifactMessage {...props} />;
}

const textOf = (content: CopilotChatUserMessageProps["message"]["content"]) =>
  typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("");

function UserMessage(props: CopilotChatUserMessageProps) {
  const entrance = useMessageEntrance(props.message.id);
  const { text, paths } = sentFilesOf(textOf(props.message.content));
  return <Rises {...entrance}><Message from="user" className="chat-message" data-message-id={props.message.id}>
    <SentFileCards paths={paths} fileUrl={agentFiles.url} />
    <Fades>{text && <MessageContent className="chat-bubble whitespace-pre-wrap">{text}</MessageContent>}</Fades>
  </Message></Rises>;
}

export const USER_MESSAGE = Object.assign(UserMessage, CopilotChatUserMessage);

