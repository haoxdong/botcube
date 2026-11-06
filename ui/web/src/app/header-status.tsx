"use client";

import { cubicBezier, m as motionElement } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { Avatar } from "./avatar";
import { Presence, presenceMotion } from "./collapse";
import { motionTokens } from "./motion-tokens";

/** Longer than the 42–243 ms a queued follow-up's Turn took to start after the one before it ended, live. */
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

type Size = { width: number; height: number };

const STEPS = 24;
/** Longer than any stall seen live: WebKit's compositor shows the last painted scale once an animation ends. */
const HOLD_MS = 5000;

/**
 * The agent's name in the chat header's capsule, and "is working" under it while a Turn runs. The capsule takes
 * its new size at once and scales over from its old one, its content counter-scaled: a compositor transform keeps moving
 * while a Turn's start busies the page.
 */
export function HeaderName({ name, working }: { name: string; working: boolean }) {
  const capsule = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  useSettle(capsule, content);
  return (
    <span ref={capsule} className="chat-header-name">
      <span ref={content} className="chat-header-label">
        {name}
        <Presence>{working && <motionElement.span {...presenceMotion} layout={false} className="chat-header-status">is working</motionElement.span>}</Presence>
      </span>
    </span>
  );
}

/** Scales the capsule from its last size whenever its content changes it: the name, or "is working" coming and, faded, going. */
function useSettle(capsule: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const box = capsule.current;
    const inner = content.current;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: the refs hold the capsule and its content once mounted
    if (box === null || inner === null) return undefined;
    let last: Size = { width: box.offsetWidth, height: box.offsetHeight };
    let stop = () => {};
    const observer = new MutationObserver(() => {
      const to = { width: box.offsetWidth, height: box.offsetHeight };
      const { a, d } = new DOMMatrixReadOnly(getComputedStyle(box).transform);
      const from = { width: last.width * a, height: last.height * d };
      last = to;
      stop();
      const { move } = motionTokens();
      if (move.duration > 0 && resized(from, to)) stop = settle(box, inner, [from.width / to.width, from.height / to.height], move);
    });
    observer.observe(inner, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      stop();
    };
  },
  // Stryker disable next-line ArrayDeclaration: any constant dependency list observes from mount on
  [capsule, content]);
}

const resized = (from: Size, to: Size) =>
  from.width * from.height * to.width * to.height > 0 && (Math.abs(to.width - from.width) >= 1 || Math.abs(to.height - from.height) >= 1);

function settle(box: HTMLElement, inner: HTMLElement, scale: [number, number], move: ReturnType<typeof motionTokens>["move"]) {
  const ease = move.ease ? cubicBezier(...move.ease) : (progress: number) => progress;
  const duration = move.duration * 1000;
  const [width, height] = scale;
  const scales = Array.from({ length: STEPS + 1 }, (_, step) => {
    const along = ease(step / STEPS);
    return [width + (1 - width) * along, height + (1 - height) * along] as const;
  });
  const frames = (transform: (x: number, y: number) => string): Keyframe[] => [
    ...scales.map(([x, y], step) => ({ transform: transform(x, y), offset: (step / STEPS) * (duration / (duration + HOLD_MS)) })),
    { transform: "none", offset: 1 },
  ];
  // About the capsule's top centre (motion.css), so the name holds still.
  inner.style.transformOrigin = `50% ${-(inner.offsetTop + box.clientTop)}px`;
  const runs = [box.animate(frames((x, y) => `scale(${x}, ${y})`), duration + HOLD_MS), inner.animate(frames((x, y) => `scale(${1 / x}, ${1 / y})`), duration + HOLD_MS)];
  // Counted from the first frame, as the scale starts there: begun inside a long task, as a Turn start on a long chat
  // is, a timer from here ran out before that frame and cancelled the scale unseen, a one-frame grow.
  let done: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelAnimationFrame(first);
    clearTimeout(done);
    for (const run of runs) run.cancel();
  };
  const first = requestAnimationFrame(() => {
    done = setTimeout(stop, duration);
  });
  return stop;
}

/** The chat's header: the agent, which opens its profile. */
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
