"use client";

import { AnimatePresence, domAnimation, domMax, isMotionComponent, LazyMotion, MotionConfig, m, useIsPresent, type HTMLMotionProps } from "motion/react";
import { Children, Fragment, cloneElement, isValidElement, useRef, useState, type Key, type KeyboardEventHandler, type ReactNode, type ReactElement, type Ref } from "react";

import { motionTokens } from "./motion-tokens";

type Tag = "div" | "li" | "span";

type PresenceChildProps = { children?: ReactNode; inert?: boolean | undefined; initial?: unknown };

export const presenceMotion = { layout: true, initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };

function presenceChildren(children: ReactNode, prefix = ""): ReactElement<PresenceChildProps>[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<PresenceChildProps>(child)) return [];
    const key = `${prefix}/${child.key}`;
    return child.type === Fragment ? presenceChildren(child.props.children, key) : [cloneElement(child, { key })];
  });
}

function Present({ children }: { children: ReactElement<{ inert?: boolean | undefined; initial?: unknown }> }) {
  const present = useIsPresent();
  return cloneElement(children, { inert: present ? children.props.inert : true });
}

export function Presence({ children }: { children: ReactNode }) {
  const instant = useInstant();
  const { quick, move } = motionTokens();
  if (instant) return presenceChildren(children).map((child) => isMotionComponent(child.type) ? cloneElement(child, { initial: false }) : child);
  return <LazyMotion features={domMax} strict><MotionConfig transition={{ opacity: quick, layout: move }}><AnimatePresence initial={false}>{presenceChildren(children).map((child) => <Present key={child.key}>{child}</Present>)}</AnimatePresence></MotionConfig></LazyMotion>;
}

export function Layout({ children, ...props }: HTMLMotionProps<"div">) {
  const { move } = motionTokens();
  return <LazyMotion features={domMax} strict><m.div layout transition={{ layout: move }} {...props}>{Array.isArray(children) ? Children.toArray(children) : children}</m.div></LazyMotion>;
}

export function Swap({ state, children, className, as = "div" }: { state: Key; children: ReactNode; className?: string; as?: Tag }) {
  const instant = useInstant();
  const { quick, move } = motionTokens();
  const Box = as;
  if (instant) return <Box key={state} className={className}>{children}</Box>;
  return (
    <LazyMotion features={domAnimation} strict><MotionConfig transition={{ opacity: quick, layout: move }}><AnimatePresence mode="popLayout" initial={false}>
      <Fading key={state} as={as} className={className ?? ""}>{children}</Fading>
    </AnimatePresence></MotionConfig></LazyMotion>
  );
}

export function useInstant() {
  const [instant] = useState(() => {
    const { move, quick } = motionTokens();
    return move.duration === 0 && quick.duration === 0;
  });
  return instant;
}

function shownHeight(box: HTMLElement | null): number {
  if (box === null) throw new Error("A closing Collapsible has no box to close from");
  const height = Number.parseFloat(getComputedStyle(box).height);
  // A box with no layout box, as under a hidden ancestor, computes "auto"; it shows its layout height, 0 there.
  return Number.isNaN(height) ? box.offsetHeight : height;
}

function Collapsible({ as = "div", children }: { as?: Tag; children: ReactNode }) {
  const present = useIsPresent();
  const { move, quick } = motionTokens();
  const box = useRef<HTMLElement | null>(null);
  const Box = as === "li" ? m.li : m.div;
  // Motion measures an auto-height exit at zero and clamps bottom-held scrollers; give it a numeric origin.
  const variants = { closed: () => ({ height: [shownHeight(box.current), 0], opacity: 0 }) };
  return (
    <LazyMotion features={domMax} strict>
      <Box
        ref={(node: HTMLElement | null) => {
          box.current = node;
        }}
        className="collapsible"
        data-closing={present ? undefined : true}
        inert={present ? undefined : true}
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit="closed"
        variants={variants}
        transition={{ height: move, opacity: quick }}
      >
        <div>{children}</div>
      </Box>
    </LazyMotion>
  );
}

export function Collapse({ open, appear = true, children }: { open: boolean; appear?: boolean; children: ReactNode }) {
  const instant = useInstant();
  if (instant) return open ? <div className="collapsible"><div>{children}</div></div> : null;
  return <AnimatePresence initial={appear}>{open && <Collapsible>{children}</Collapsible>}</AnimatePresence>;
}

export function CollapseList({ children, initial = false, ...presence }: { children: ReactNode; initial?: boolean; onExitComplete?: () => void }) {
  const instant = useInstant();
  return instant ? children : <AnimatePresence initial={initial} {...presence}>{children}</AnimatePresence>;
}

export function CollapseItem({ as: Row = "div", children }: { as?: Tag; children: ReactNode }) {
  const instant = useInstant();
  if (instant) return <Row className="collapsible"><div>{children}</div></Row>;
  return <Collapsible as={Row}>{children}</Collapsible>;
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
