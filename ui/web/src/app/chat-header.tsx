"use client";

import { m as motionElement } from "motion/react";
import { useEffect, useState, type RefObject } from "react";

import { Avatar } from "./avatar";
import { Presence, presenceMotion } from "./collapse";

// A state hold, not motion: a waiting message carried into the next Turn starts it a task after the last one ends, so
// "is working" holds across the gap instead of blinking (steering.stories.tsx, chat-steering-carried-working).
const BETWEEN_TURNS_MS = 300;

export function useHeaderWorking(chatId: string | null, working: boolean) {
  const [heldFor, setHeldFor] = useState(working ? chatId : null);
  useEffect(() => {
    if (working) {
      setHeldFor(chatId);
      return undefined;
    }
    const rest = window.setTimeout(() => setHeldFor(null), BETWEEN_TURNS_MS);
    return () => window.clearTimeout(rest);
  }, [chatId, working]);
  return chatId !== null && (working || heldFor === chatId);
}

export function HeaderName({ name, working }: { name: string; working: boolean }) {
  return (
    <span className="chat-header-name">
      <span className="chat-header-label">
        {name}
        <Presence>{working && <motionElement.span {...presenceMotion} className="chat-header-status">is working</motionElement.span>}</Presence>
      </span>
    </span>
  );
}

export function ChatHeader({ opener, working, ready, chatId, open, picture, emoji, name }: {
  opener: RefObject<HTMLButtonElement | null>;
  working: boolean;
  ready: boolean;
  chatId: string | null;
  open: () => void;
  picture: string | null | undefined;
  emoji: string | undefined;
  name: string;
}) {
  return (
    <header className="chat-header">
      <button ref={opener} className="chat-header-agent" data-working={working || undefined} disabled={!ready || chatId === null} onClick={open} aria-label="Agent profile" title="Agent profile">
        <Avatar picture={picture ?? undefined} emoji={emoji} name={name} agent working={working} size={72} />
        <HeaderName name={name} working={working} />
      </button>
    </header>
  );
}
