"use client";

import { Fades } from "./motion";
import { useEffect, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar } from "./avatar";
import { BOT_SETTINGS } from "../bot-settings";
import { preloadComputerView } from "../computer/agent-computer-view";

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
        <Fades>{working && <span className="chat-header-status">is working</span>}</Fades>
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
  useEffect(() => {
    if (ready && BOT_SETTINGS.agentComputer.enabled) preloadComputerView();
  }, [ready]);
  return (
    <header className="chat-header">
      <Tooltip>
        <TooltipTrigger render={<Button ref={opener} variant="ghost" className="chat-header-agent" data-working={working || undefined} disabled={!ready || chatId === null} onClick={open} aria-label="Agent profile" />}>
          <Avatar picture={picture ?? undefined} emoji={emoji} name={name} agent working={working} size={72} />
          <HeaderName name={name} working={working} />
        </TooltipTrigger>
        <TooltipContent>Agent profile</TooltipContent>
      </Tooltip>
    </header>
  );
}
