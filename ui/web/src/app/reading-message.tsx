"use client";

import { CopilotChatUserMessage, type CopilotChatAssistantMessageProps, type CopilotChatUserMessageProps } from "@copilotkit/react-core/v2";
import { AnimatePresence, domAnimation, LazyMotion, m as motionElement } from "motion/react";
import type { ComponentPropsWithRef } from "react";
import { useMessageEntrance } from "./message-entrance";
import { SentMessage } from "./sent-message";
import { ArtifactMessage } from "./artifact-message";
import MarkdownRenderer from "./markdown-renderer";
import { ScheduledRunCard, scheduledRunOf } from "./scheduled-run-card";

export function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const run = scheduledRunOf(props.message);
  if (run !== null) return <div data-message-id={props.message.id}><ScheduledRunCard run={run}><MarkdownRenderer content={run.text} /></ScheduledRunCard></div>;
  return <ArtifactMessage {...props} />;
}


const MotionUserMessage = motionElement.create(function UserMessageRoot({ sdkProps, style, ref }: { sdkProps: CopilotChatUserMessageProps } & Pick<ComponentPropsWithRef<"div">, "style" | "ref">) {
  const rootProps = { ...sdkProps, style: { ...sdkProps.style, ...style }, ref };
  return <CopilotChatUserMessage {...rootProps} />;
});

function UserMessage(props: CopilotChatUserMessageProps) {
  const entrance = useMessageEntrance(props.message.id);
  const sdkProps = { ...props, messageRenderer: SentMessage };
  return <LazyMotion features={domAnimation} strict><AnimatePresence><MotionUserMessage sdkProps={sdkProps} {...entrance} /></AnimatePresence></LazyMotion>;
}

export const USER_MESSAGE = Object.assign(UserMessage, CopilotChatUserMessage);

