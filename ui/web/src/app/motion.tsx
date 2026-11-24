"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { moveMs } from "./motion-tokens";

// One motion per user action. These fade on the Web Animations API, so `document.getAnimations()` sees
// every one and the Storybook motion budget holds them; neither nests another fade, so a change never stacks stages.

export const Arriving = createContext(false);

function cssMs(name: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith("ms") ? amount : amount * 1000;
}

/** How shown `element` is now, mid-fade or not; an opacity no stylesheet resolves reads as fully shown. */
function shown(element: HTMLElement) {
  const opacity = getComputedStyle(element).opacity;
  return opacity === "" ? 1 : Number(opacity);
}

/**
 * Fades `element` to `to` on --motion-quick, from `from` or from where a running fade has it now. A fade out holds
 * its end until the element unmounts. Null where motion is off.
 */
function fade(element: HTMLElement, to: 0 | 1, from = shown(element)): Animation | null {
  for (const running of element.getAnimations()) running.cancel();
  const duration = cssMs("--motion-quick");
  if (duration === 0 || from === to) return null;
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease";
  return element.animate([{ opacity: from }, { opacity: to }], { duration, easing, fill: to === 0 ? "forwards" : "none" });
}

/** Whether `on` has held for a full --motion-move: a wait shorter than a motion shows nothing. At once where motion is off. */
export function useAfterMove(on: boolean) {
  const [after, setAfter] = useState(false);
  useLayoutEffect(() => {
    if (!on) return;
    const wait = moveMs();
    if (wait === 0) setAfter(true);
    const timer = setTimeout(() => setAfter(true), wait);
    return () => {
      clearTimeout(timer);
      setAfter(false);
    };
  }, [on]);
  return after;
}

type Box = {
  className?: string | undefined;
  role?: string | undefined;
  "aria-label"?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
};

/**
 * The box's element, and whether it is a new element since the last fade read it. React detaches and reattaches a ref
 * that changes between renders, so only a different element counts as new.
 */
function useBox(ref: Ref<HTMLDivElement> | undefined) {
  const box = useRef<{ element: HTMLDivElement | null; fresh: boolean }>({ element: null, fresh: false });
  const attach = (node: HTMLDivElement | null) => {
    if (node !== null && node !== box.current.element) box.current = { element: node, fresh: true };
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  return [box, attach] as const;
}

/**
 * Its children while `when`: they fade in once when `when` turns true and fade out once before they unmount, keeping
 * what they last showed. Present at mount, they show at once.
 */
export function Shows({ when, children, ref, ...rest }: Box & { when: boolean; children: ReactNode }) {
  const [box, attach] = useBox(ref);
  const [rendered, setRendered] = useState(when);
  const [kept, setKept] = useState(children);
  const [last, setLast] = useState(when);
  const [flips, setFlips] = useState(0);
  if (when !== last) {
    setLast(when);
    setFlips(flips + 1);
    if (when) setRendered(true);
  }
  if (when && kept !== children) setKept(children);

  useLayoutEffect(() => {
    const { element, fresh } = box.current;
    box.current.fresh = false;
    if (flips === 0 || element === null) return;
    const animation = fade(element, when ? 1 : 0, fresh ? 0 : undefined);
    if (when) return;
    if (animation === null) setRendered(false);
    else animation.onfinish = () => setRendered(false);
  }, [flips, when, box]);

  if (!rendered) return null;
  return <div ref={attach} inert={when ? undefined : true} {...rest}>{when ? children : kept}</div>;
}

/**
 * Its children, replaced at once whenever `state` changes. What arrives after a wait takes one quick fade in place;
 * a wait (`waiting`, a skeleton) shows at once, and nothing fades out.
 */
export function Arrives({ state, waiting = false, children, ref, ...rest }: Box & { state: string; waiting?: boolean; children: ReactNode }) {
  const [box, attach] = useBox(ref);
  const [last, setLast] = useState(state);
  const [arrivals, setArrivals] = useState(0);
  const arriving = useContext(Arriving);
  if (state !== last) {
    setLast(state);
    if (!waiting && !arriving) setArrivals(arrivals + 1);
  }

  useLayoutEffect(() => {
    const { element } = box.current;
    if (arrivals > 0 && element !== null) fade(element, 1, 0);
  }, [arrivals, box]);

  return <div ref={attach} {...rest}>{children}</div>;
}
