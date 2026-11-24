"use client";

import { AnimatePresence, domAnimation, domMax, isMotionComponent, LazyMotion, MotionConfig, m, useIsPresent, usePresence, type HTMLMotionProps } from "motion/react";
import { Children, Fragment, cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState, type Key, type KeyboardEventHandler, type ReactNode, type ReactElement, type Ref, type TransitionEvent } from "react";

import { motionTokens } from "./motion-tokens";
import { Arriving } from "./motion";

type Tag = "div" | "li" | "span";

type PresenceChildProps = { children?: ReactNode; inert?: boolean | undefined; initial?: unknown };

export const presenceMotion = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
// What rides a zoom (the Agent Computer's sheet) springs to its new box on --motion-move, as the zoom does.
export const zoomMotion = { ...presenceMotion, layout: true };

function presenceChildren(children: ReactNode, prefix = ""): ReactElement<PresenceChildProps>[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<PresenceChildProps>(child)) return [];
    const key = `${prefix}/${child.key}`;
    return child.type === Fragment ? presenceChildren(child.props.children, key) : [cloneElement(child, { key })];
  });
}

function Present({ move, children }: { move: ReturnType<typeof motionTokens>["move"]; children: ReactElement<{ inert?: boolean | undefined; initial?: unknown }> }) {
  const present = useIsPresent();
  const arriving = useContext(Arriving);
  return cloneElement(children, { inert: present ? children.props.inert : true, ...(arriving ? { initial: false, transition: { opacity: { duration: 0 }, layout: move } } : {}) });
}

export function Presence({ children }: { children: ReactNode }) {
  const instant = useInstant();
  const { quick, move } = motionTokens();
  if (instant) return presenceChildren(children).map((child) => isMotionComponent(child.type) ? cloneElement(child, { initial: false }) : child);
  return <LazyMotion features={domMax} strict><MotionConfig transition={{ opacity: quick, layout: move }}><AnimatePresence initial={false}>{presenceChildren(children).map((child) => <Present key={child.key} move={move}>{child}</Present>)}</AnimatePresence></MotionConfig></LazyMotion>;
}

export function Layout({ children, ...props }: HTMLMotionProps<"div">) {
  const { move } = motionTokens();
  const box = <m.div layout transition={{ layout: move }} {...props}>{Array.isArray(children) ? Children.toArray(children) : children}</m.div>;
  return move.visualDuration === 0 ? box : <LazyMotion features={domMax} strict>{box}</LazyMotion>;
}

export function Swap({ state, children, className, as = "div" }: { state: Key; children: ReactNode; className?: string; as?: Tag }) {
  const instant = useInstant();
  const { quick } = motionTokens();
  const Box = as;
  if (instant) return <Box key={state} className={className}>{children}</Box>;
  return (
    <LazyMotion features={domAnimation} strict><MotionConfig transition={{ opacity: quick }}><AnimatePresence mode="popLayout" initial={false}>
      <Fading key={state} as={as} className={className ?? ""}>{children}</Fading>
    </AnimatePresence></MotionConfig></LazyMotion>
  );
}

export function useInstant() {
  const [instant] = useState(() => {
    const { move, quick } = motionTokens();
    return move.visualDuration === 0 && quick.visualDuration === 0;
  });
  return instant;
}

const closesRows = (animation: Animation) => "transitionProperty" in animation && animation.transitionProperty === "grid-template-rows";

// Kept: Motion measures an auto-height exit at zero and clamps bottom-held scrollers, so this tweens CSS grid rows.
// What opens and closes in the column grows its rows from nothing on --motion-move and closes them before it unmounts
// (motion.css), so what follows moves with it: never a held gap, then a jump.
function Collapsible({ as = "div", still, children }: { as?: Tag; still: boolean; children: ReactNode }) {
  const [present, safeToRemove] = usePresence();
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (present) return;
    if (box.current === null) throw new Error("A closing Collapse has no box to close from");
    // No transitionend comes when the rows start no transition: a zero --motion-move, or a box under a hidden ancestor.
    if (!box.current.getAnimations().some(closesRows)) safeToRemove();
  }, [present, safeToRemove]);
  const Box = as;
  return (
    <Box
      ref={(node: HTMLElement | null) => {
        box.current = node;
      }}
      className="collapsible grid-collapse"
      data-still={still || undefined}
      data-closing={present ? undefined : true}
      inert={present ? undefined : true}
      onTransitionEnd={(event: TransitionEvent<HTMLElement>) => {
        if (!present && event.target === event.currentTarget && event.propertyName === "grid-template-rows") safeToRemove();
      }}
    >
      <div>{children}</div>
    </Box>
  );
}

export function Collapse({ open, appear = true, children }: { open: boolean; appear?: boolean; children: ReactNode }) {
  const instant = useInstant();
  const [shown, setShown] = useState(open);
  const [opens, setOpens] = useState(0);
  if (open !== shown) {
    setShown(open);
    if (open) setOpens(opens + 1);
  }
  if (instant) return open ? <div className="collapsible"><div>{children}</div></div> : null;
  return <AnimatePresence initial={false}>{open && <Collapsible key="open" still={!appear && opens === 0}>{children}</Collapsible>}</AnimatePresence>;
}

// True while a CollapseList mounts its first rows, which show at once unless the list asks them to grow in.
const ListMounting = createContext(false);

export function CollapseList({ children, initial = false, ...presence }: { children: ReactNode; initial?: boolean; onExitComplete?: () => void }) {
  const instant = useInstant();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (instant) return children;
  return <ListMounting value={!mounted && !initial}><AnimatePresence initial={initial} {...presence}>{children}</AnimatePresence></ListMounting>;
}

export function CollapseItem({ as: Row = "div", children }: { as?: Tag; children: ReactNode }) {
  const instant = useInstant();
  const [still] = useState(useContext(ListMounting));
  if (instant) return <Row className="collapsible"><div>{children}</div></Row>;
  return <Collapsible as={Row} still={still}>{children}</Collapsible>;
}

type FadeProps = {
  open: boolean;
  className: string;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  role?: string;
  "aria-label"?: string | undefined;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
};

type FadingProps = Omit<FadeProps, "open" | "ref" | "onKeyDown"> & {
  title?: string | undefined;
  "data-status"?: string | undefined;
} & (
  | { as?: "div"; ref?: Ref<HTMLDivElement>; onKeyDown?: KeyboardEventHandler<HTMLDivElement> }
  | { as: "li" | "span"; ref?: never; onKeyDown?: never }
);

function Fading({ as = "div", children, ref, onKeyDown, ...box }: FadingProps) {
  const present = useIsPresent();
  const { quick } = motionTokens();
  const fade = { inert: present ? undefined : true, initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { opacity: quick } };
  if (as === "li") return <m.li {...box} {...fade}>{children}</m.li>;
  if (as === "span") return <m.span {...box} style={{ display: "inline-block" }} {...fade}>{children}</m.span>;
  return <m.div {...box} ref={ref} onKeyDown={onKeyDown} {...fade}>{children}</m.div>;
}

export function Fade({ open, ...box }: FadeProps) {
  const instant = useInstant();
  if (instant) {
    const { children, ...rest } = box;
    return open ? <div {...rest}>{children}</div> : null;
  }
  return <LazyMotion features={domMax} strict><AnimatePresence>{open && <Fading {...box} />}</AnimatePresence></LazyMotion>;
}

type FadeItemProps = {
  className: string;
  children: ReactNode;
  title?: string | undefined;
  "data-status"?: string | undefined;
};

export function FadeItem({ children, ...row }: FadeItemProps) {
  const instant = useInstant();
  if (instant) return <li {...row}>{children}</li>;
  return <LazyMotion features={domMax} strict><Fading as="li" {...row}>{children}</Fading></LazyMotion>;
}
