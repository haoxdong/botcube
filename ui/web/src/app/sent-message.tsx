"use client";

import { m as motionElement } from "motion/react";
import { Presence, presenceMotion } from "./collapse";
import { agentFiles } from "./agent-files";
import { SentFileCards, sentFilesOf } from "./composer-files";
import { USER_MESSAGE_CLASS } from "./bubble-width";

export function SentMessage({ content }: { content: string }) {
  const { text, paths } = sentFilesOf(content);
  return (
    <>
      <SentFileCards paths={paths} fileUrl={agentFiles.url} />
      <Presence>{text && <motionElement.div {...presenceMotion} className={USER_MESSAGE_CLASS}>{text}</motionElement.div>}</Presence>
    </>
  );
}

