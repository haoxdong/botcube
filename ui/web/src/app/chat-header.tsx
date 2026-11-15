"use client";

import { LayoutGroup, LazyMotion, m as motionElement } from "framer-motion";
import { useEffect, useState, type RefObject } from "react";

import { Avatar } from "./avatar";
import { Presence, presenceMotion } from "./collapse";
import { motionTokens } from "./motion-tokens";

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

const loadFeatures = () => import("./motion-features").then((module) => module.default);

export function HeaderName({ name, working }: { name: string; working: boolean }) {
  const { move } = motionTokens();
  const layoutDependency = `${name}:${working}`;
  const transition = { layout: { type: "spring" as const, visualDuration: move.duration, bounce: 0 } };
  return (
    <LazyMotion features={loadFeatures} strict><LayoutGroup>
      <motionElement.span layout layoutDependency={layoutDependency} transition={transition} className="chat-header-name">
        <motionElement.span layout="position" layoutDependency={layoutDependency} transition={transition} className="chat-header-label">
          {name}
          <Presence>{working && <motionElement.span {...presenceMotion} layout={false} className="chat-header-status">is working</motionElement.span>}</Presence>
        </motionElement.span>
      </motionElement.span>
    </LayoutGroup></LazyMotion>
  );
}

export function ChatHeader({ opener, working, ready, chatId, open, picture, emoji, name }: {
  opener: RefObject<HTMLButtonElement | null>;
  working: boolean;
  /** The account's profile loads: never for a temporary chat. */
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
