"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion } from "./collapse";
import { useState } from "react";
import { agentFiles } from "./agent-files";
import { SentFileCards, sentFilesOf } from "./composer-files";
import { USER_MESSAGE_CLASS } from "./bubble-width";
import { NATIVE_READING, readingStyle, useReadingSize } from "./native-reading";

export function SentMessage({ content }: { content: string }) {
  const [bubble, setBubble] = useState<HTMLDivElement | null>(null);
  const size = useReadingSize(bubble);
  const { text, paths } = sentFilesOf(content);
  return (
    <>
      <SentFileCards paths={paths} fileUrl={agentFiles.url} />
      <Presence>{text && <motionElement.div {...presenceMotion} ref={NATIVE_READING ? setBubble : undefined} data-reading-user={NATIVE_READING ? "" : undefined} data-reading-bubble={size === undefined ? undefined : ""} style={readingStyle(size)} className={USER_MESSAGE_CLASS}>{text}</motionElement.div>}</Presence>
    </>
  );
}

