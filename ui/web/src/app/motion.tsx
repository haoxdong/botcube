"use client";

import {
  Children, Component, Fragment, cloneElement, createContext, isValidElement, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEventHandler, type ReactElement, type ReactNode, type Ref,
} from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { moveMs } from "./motion-tokens";

// The web app's one motion engine (ADR 0094's motion part): one motion per user action, each on the Web Animations
// API, so `document.getAnimations()` sees every one and the Storybook motion budget holds them.

/** True while what holds it slides in (a phone drawer, the Agent Profile): what comes or goes in it then shows or goes at
    once, as part of that one motion, rather than fading on its own. */
export const Arriving = createContext(false);

function cssMs(name: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith("ms") ? amount : amount * 1000;
}

/** The motion tokens' curve, --ease, for the Web Animations API. */
const easing = () => getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease";

/** How shown `element` is now, mid-fade or not; an opacity no stylesheet resolves reads as fully shown. */
function shown(element: HTMLElement | SVGElement) {
  const opacity = getComputedStyle(element).opacity;
  return opacity === "" ? 1 : Number(opacity);
}

/**
 * Fades `element` to `to` on --motion-quick, from `from` or from where a running fade has it now. A fade out holds
 * its end until the element unmounts. Null where motion is off.
 */
function fade(element: HTMLElement | SVGElement, to: 0 | 1, from?: number): Animation | null {
  const duration = cssMs("--motion-quick");
  if (duration === 0) return null;
  const start = from ?? shown(element);
  for (const running of element.getAnimations()) running.cancel();
  if (start === to) return null;
  return element.animate([{ opacity: start }, { opacity: to }], { duration, easing: easing(), fill: to === 0 ? "forwards" : "none" });
}

/**
 * Folds `element` open (1) to its height or shut (0) to nothing on --motion-move, fading on --motion-quick as it
 * goes: from nothing (`from` 0) or from where a running fold has it now. A fold shut holds its end until the element
 * unmounts. Null where motion is off.
 */
function fold(element: HTMLElement | SVGElement, to: 0 | 1, from?: 0, edge: Keyframe = {}): Animation | null {
  const duration = cssMs("--motion-move");
  if (duration === 0) return null;
  const start = from === 0 ? { height: 0, opacity: 0 } : { height: element.getBoundingClientRect().height, opacity: shown(element) };
  for (const running of element.getAnimations()) running.cancel();
  const height = to === 0 ? 0 : element.getBoundingClientRect().height;
  if (start.height === height && start.opacity === to) return null;
  const faded = Math.min(1, cssMs("--motion-quick") / duration);
  return element.animate(
    [{ height: `${start.height}px`, opacity: start.opacity }, { opacity: to, offset: faded }, { height: `${height}px`, opacity: to, ...edge }],
    { duration, easing: easing(), fill: to === 0 ? "forwards" : "none" },
  );
}

/**
 * Folds `element`, a row that stays mounted until it is gone, from where it stands to nothing, with any `edge` it gives
 * up (a margin) on the way, then calls `done`; at once where motion is off.
 */
export function foldAway(element: HTMLElement, done: () => void, edge: Keyframe = {}) {
  const animation = fold(element, 0, undefined, edge);
  if (animation === null) return done();
  animation.onfinish = done;
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
  onKeyDown?: KeyboardEventHandler<HTMLDivElement> | undefined;
};

type Faded = ReactElement<{ ref?: Ref<Element> | undefined; inert?: boolean | undefined }>;
type Entry = { key: string; element: Faded; leaving: boolean; enters: boolean };

function keyed(children: ReactNode, prefix = ""): Faded[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; ref?: Ref<Element> }>(child)) return [];
    const key = `${prefix}/${child.key}`;
    return child.type === Fragment ? keyed(child.props.children, key) : [cloneElement(child, { key })];
  });
}

/** `now` in its order, with each child of `before` that has gone kept, leaving, after the neighbour it followed. */
function merged(before: Entry[], now: Faded[]): Entry[] {
  const entries = now.map((element) => {
    const key = String(element.key);
    return { key, element, leaving: false, enters: before.find((entry) => entry.key === key)?.enters ?? true };
  });
  before.forEach((entry, index) => {
    if (entries.some(({ key }) => key === entry.key)) return;
    const after = before.slice(0, index).findLast((earlier) => entries.some(({ key }) => key === earlier.key));
    entries.splice(after ? entries.findIndex(({ key }) => key === after.key) + 1 : 0, 0, { ...entry, leaving: true });
  });
  return entries;
}

function assign(ref: Ref<Element> | undefined, node: Element | null) {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

function FadedChild({ entry, gone, folds }: { entry: Entry; gone: (key: string) => void; folds: boolean }) {
  const { key, element, leaving, enters } = entry;
  // Read as it comes or goes, not followed: the slide ending moves nothing.
  const inArrival = useContext(Arriving);
  const arriving = useRef(inArrival);
  const node = useRef<Element | null>(null);
  const first = useRef(true);
  const own = element.props.ref;
  const attach = useCallback((target: Element | null) => {
    node.current = target;
    assign(own, target);
  }, [own]);
  useLayoutEffect(() => {
    arriving.current = inArrival;
  }, [inArrival]);
  useLayoutEffect(() => {
    const target = node.current;
    const mounting = first.current;
    first.current = false;
    if (!(target instanceof HTMLElement || target instanceof SVGElement)) {
      if (leaving) gone(key);
      return;
    }
    const move = folds ? fold : fade;
    if (!leaving) {
      if (!mounting) move(target, 1);
      else if (enters && !arriving.current) move(target, 1, 0);
      return;
    }
    const animation = arriving.current ? null : move(target, 0);
    if (animation === null) {
      gone(key);
      return;
    }
    animation.onfinish = () => gone(key);
    return () => {
      animation.onfinish = null;
    };
  }, [leaving, enters, key, gone, folds]);
  return cloneElement(element, { ref: attach, ...(leaving ? { inert: true } : {}) });
}

/**
 * Each of its keyed children fades in once as it comes and out once, inert, before it goes; what goes keeps what it
 * last showed, in its place. Present at mount, they show at once, unless `appear`. `onExitComplete` follows the last
 * one out. With `folds`, each also grows from nothing to its height as it comes and closes to nothing before it goes,
 * so what follows moves with it: a list's rows, each a `.collapsible` (motion.css) whose inner box holds its margins.
 */
export function Fades({ children, appear = false, folds = false, onExitComplete }: { children: ReactNode; appear?: boolean; folds?: boolean; onExitComplete?: () => void }) {
  const [last, setLast] = useState(children);
  const [entries, setEntries] = useState<Entry[]>(() => keyed(children).map((element) => ({ key: String(element.key), element, leaving: false, enters: appear })));
  if (children !== last) {
    setLast(children);
    setEntries(merged(entries, keyed(children)));
  }
  const gone = useCallback((key: string) => setEntries((current) => current.filter((entry) => !(entry.key === key && entry.leaving))), []);
  const leaving = entries.some((entry) => entry.leaving);
  const wasLeaving = useRef(false);
  useEffect(() => {
    if (wasLeaving.current && !leaving) onExitComplete?.();
    wasLeaving.current = leaving;
  }, [leaving, onExitComplete]);
  return entries.map((entry) => <FadedChild key={entry.key} entry={entry} gone={gone} folds={folds} />);
}

/**
 * Its children while `when`: they fade in once when `when` turns true and fade out once before they unmount, keeping
 * what they last showed. Present at mount, they show at once, unless `appear`.
 */
export function Shows({ when, appear, children, ...box }: Box & { when: boolean; appear?: boolean; children: ReactNode }) {
  return <Fades appear={appear ?? false}>{when && <div key="shown" {...box}>{children}</div>}</Fades>;
}

/**
 * Its children, a new box whenever `state` changes. What arrives after a wait takes one quick fade in place;
 * a wait (`waiting`, a skeleton) shows at once, and nothing fades out.
 */
export function Arrives({ state, waiting = false, as = "div", children, ...rest }: Omit<Box, "ref" | "onKeyDown"> & { state: string; waiting?: boolean; as?: "div" | "span" | "li"; title?: string | undefined; children: ReactNode }) {
  const box = useRef<HTMLElement | null>(null);
  const [last, setLast] = useState(state);
  const [arrivals, setArrivals] = useState(0);
  const arriving = useContext(Arriving);
  if (state !== last) {
    setLast(state);
    if (!waiting && !arriving) setArrivals(arrivals + 1);
  }

  useLayoutEffect(() => {
    if (arrivals > 0 && box.current !== null) fade(box.current, 1, 0);
  }, [arrivals]);

  const Box = as;
  return <Box key={state} ref={(node: HTMLElement | null) => { box.current = node; }} {...rest} {...(as === "span" ? { style: { display: "inline-block" } } : {})}>{children}</Box>;
}

/**
 * Its one child, risen into place once as it mounts when it `arrives`: 6px up and in, on --motion-move. A child
 * `replaced` before it lands stands at rest at once.
 */
export function Rises({ arrives, replaced, children }: { arrives: boolean; replaced: boolean; children: Faded }) {
  const node = useRef<Element | null>(null);
  const rising = useRef<Animation | null>(null);
  const own = children.props.ref;
  const attach = useCallback((target: Element | null) => {
    node.current = target;
    assign(own, target);
  }, [own]);
  useLayoutEffect(() => {
    const target = node.current;
    const duration = cssMs("--motion-move");
    if (!arrives || !(target instanceof HTMLElement) || duration === 0) return;
    rising.current = target.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration, easing: easing() });
  }, [arrives]);
  useLayoutEffect(() => {
    if (replaced) rising.current?.cancel();
  }, [replaced]);
  return cloneElement(children, { ref: attach });
}

/** Moves `element` from the box it had, `from`, to where it is now, on --motion-move: by its position, or its whole box. */
function glide(element: HTMLElement, from: DOMRect, scales: boolean) {
  const duration = cssMs("--motion-move");
  if (duration === 0) return;
  for (const running of element.getAnimations()) running.cancel();
  const to = element.getBoundingClientRect();
  const x = from.left - to.left;
  const y = from.top - to.top;
  const scale = scales && to.width > 0 && to.height > 0 ? ` scale(${from.width / to.width}, ${from.height / to.height})` : "";
  if (x === 0 && y === 0 && scale === "") return;
  element.animate([{ transformOrigin: "0 0", transform: `translate(${x}px, ${y}px)${scale}` }, { transformOrigin: "0 0", transform: "none" }], { duration, easing: easing() });
}

type GlidesProps = { className?: string; style?: CSSProperties; on: boolean; dependency: string | boolean; scales?: boolean; children: ReactNode };

/**
 * Its box glides on the Web Animations API from where it was to where it lands whenever `dependency` changes while
 * `on`: by its position, or with `scales` its whole box. A class: only getSnapshotBeforeUpdate reads the box before
 * React changes the page.
 */
export class Glides extends Component<GlidesProps> {
  private element: HTMLDivElement | null = null;

  override getSnapshotBeforeUpdate(previous: GlidesProps): DOMRect | null {
    if (!this.props.on || previous.dependency === this.props.dependency || this.element === null) return null;
    return this.element.getBoundingClientRect();
  }

  override componentDidUpdate(_props: GlidesProps, _state: unknown, from: DOMRect | null) {
    const { element } = this;
    if (element !== null && !this.props.on && cssMs("--motion-move") > 0) for (const running of element.getAnimations()) running.cancel();
    if (from === null || element === null) return;
    queueMicrotask(() => glide(element, from, this.props.scales ?? false));
  }

  override render() {
    const { className, style, children } = this.props;
    return <div ref={(node) => { this.element = node; }} className={className} style={style}>{children}</div>;
  }
}

type FoldsProps = { open: boolean; className?: string; inert?: boolean | undefined; children: ReactNode } & { [data: `data-${string}`]: true | undefined };

/**
 * A box that stays mounted, open or shut (`aria-hidden` and inert; its stylesheet gives it no height), whose height
 * moves once on --motion-move from where it stood to where it lands each time it opens or shuts, holding its flex
 * share still meanwhile: for a box that fills its column, which no measured height can open to. A class: only
 * getSnapshotBeforeUpdate reads the box before React changes the page; Folds hands it its ref, so a Fades can fade it.
 */
class FoldingBox extends Component<FoldsProps & { box: Ref<Element> | undefined }> {
  private element: HTMLDivElement | null = null;

  override getSnapshotBeforeUpdate(previous: FoldsProps): number | null {
    if (previous.open === this.props.open || this.element === null) return null;
    return this.element.getBoundingClientRect().height;
  }

  override componentDidUpdate(_props: FoldsProps, _state: unknown, from: number | null) {
    const { element } = this;
    const duration = cssMs("--motion-move");
    if (from === null || element === null || duration === 0) return;
    for (const running of element.getAnimations()) running.cancel();
    const to = element.getBoundingClientRect().height;
    if (from === to) return;
    element.animate([{ height: `${from}px`, flex: "none" }, { height: `${to}px`, flex: "none" }], { duration, easing: easing() });
  }

  override render() {
    const { open, className, inert, box, children, ...data } = this.props;
    const attach = (node: HTMLDivElement | null) => {
      this.element = node;
      assign(box, node);
    };
    return <div ref={attach} {...data} className={className} aria-hidden={!open} inert={!open || inert || undefined}>{children}</div>;
  }
}

export function Folds({ ref, ...props }: FoldsProps & { ref?: Ref<Element> | undefined }) {
  return <FoldingBox {...props} box={ref} />;
}

/**
 * Slides `element`'s registered number `property` to `to` on --motion-move from where it is now, then calls `done`;
 * at once where motion is off.
 */
export function slide(element: HTMLElement, property: `--${string}`, to: number, done: () => void) {
  const from = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  const duration = cssMs("--motion-move");
  if (duration > 0) for (const running of element.getAnimations()) if (running.id === property) running.cancel();
  element.style.setProperty(property, String(to));
  if (duration === 0 || Number.isNaN(from) || from === to) return done();
  const animation = element.animate([{ [property]: from }, { [property]: to }], { duration, easing: easing(), id: property });
  animation.onfinish = done;
}

/**
 * A section shown only while `open`, under its `trigger` if it has one: the stock Collapsible, whose content folds open
 * and shut on the motion tokens (motion.css's `.fold`) and is inert while shut.
 */
export function Fold({ open, onOpenChange, trigger, children }: { open: boolean; onOpenChange?: () => void; trigger?: ReactNode; children: ReactNode }) {
  return <Collapsible open={open} onOpenChange={onOpenChange} className="fold">{trigger}<CollapsibleContent className="collapsible" inert={!open || undefined}><div>{children}</div></CollapsibleContent></Collapsible>;
}
