"use client";

import type { CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { ArtifactMessage } from "./artifact-message";
import MarkdownRenderer from "./markdown-renderer";
import { ScheduledRunCard, scheduledRunOf } from "./scheduled-run-card";
import { readingStyle, useReadingSize } from "./native-reading";

export function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const size = useReadingSize(props.message.id);
  const contentSize = useReadingSize(props.message.id, "content");
  const run = scheduledRunOf(props.message);
  if (run !== null) return <div data-message-id={props.message.id}><ScheduledRunCard run={run}><MarkdownRenderer content={run.text} /></ScheduledRunCard></div>;
  return <ArtifactMessage {...props} data-reading-row={size === undefined ? undefined : ""} data-reading-content={contentSize === undefined ? undefined : ""} style={size || contentSize ? { ...props.style, ...readingStyle(size), ...readingStyle(contentSize, "content") } : props.style} />;
}

