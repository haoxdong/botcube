"use client";

import { Dialog } from "@base-ui/react/dialog";
import { domAnimation, LazyMotion, m as motionElement, type AnimationDefinition } from "motion/react";
import { Maximize2, X } from "lucide-react";
import { isValidElement, useContext, useRef, useState, type ComponentProps } from "react";
import { defaultComponents, StreamdownContext, type StreamdownContextType } from "streamdown";

import { Presence } from "./collapse";
import { motionTokens } from "./motion-tokens";
import { OpenFence } from "./reply-turn";

type CodeProps = ComponentProps<typeof defaultComponents.code>;
const Code = defaultComponents.code;
const CSS_FULLSCREEN = process.env.NEXT_PUBLIC_CSS_DIAGRAM_FULLSCREEN === "1";
const opacity = { hidden: { opacity: 0 }, visible: { opacity: 1 } };

export function ReplyCode(props: CodeProps) {
  const open = useContext(OpenFence);
  if (!props.className?.split(" ").includes("language-mermaid") || !("data-block" in props)) return <Code {...props} />;
  return open !== null && codeOf(props.children).trimEnd() === open.trimEnd() ? <PendingDiagram /> : <DiagramCode {...props} />;
}

const codeOf = (children: CodeProps["children"]): string =>
  typeof children === "string"
    ? children
    : isValidElement<{ children?: unknown }>(children) && typeof children.props.children === "string" ? children.props.children : "";

/** streamdown 2.7.0's mermaid block, empty while its fence streams: Mermaid draws once it closes. */
function PendingDiagram() {
  return (
    <div className="my-4 flex w-full flex-col rounded-xl border border-border" data-streamdown="mermaid-block" data-pending="">
      <div className="flex items-center text-muted-foreground text-xs"><span className="ml-1 font-mono lowercase">mermaid</span></div>
      <div />
    </div>
  );
}

function DiagramCode(props: CodeProps) {
  const context = useContext<StreamdownContextType>(StreamdownContext);
  const [open, setOpen] = useState(false);
  const actions = useRef<Dialog.Root.Actions | null>(null);
  const controls = typeof context.controls === "object" ? context.controls : {};
  const mermaid = typeof controls.mermaid === "object" ? controls.mermaid : {};
  if (context.controls === false || controls.mermaid === false || mermaid.fullscreen === false) return <Code {...props} />;
  const inline = { ...context, controls: { ...controls, mermaid: { ...mermaid, fullscreen: false } } };
  const content = <>
    <Dialog.Close className="diagram-fullscreen-close" aria-label="Exit fullscreen"><X size={20} aria-hidden /></Dialog.Close>
    <StreamdownContext.Provider value={inline}><Code {...props} /></StreamdownContext.Provider>
  </>;
  // CSS entry fades elapse during Mermaid mounting before intermediate opacity paints; Motion retains entry, while Base UI owns CSS exit.
  const fullscreen = CSS_FULLSCREEN
    ? <Dialog.Popup className="diagram-fullscreen-popup diagram-fullscreen-css" aria-label="View fullscreen" render={(popupProps, state) => <div {...popupProps} inert={!state.open} />}>
      <LazyMotion features={domAnimation} strict>
        <motionElement.div className="diagram-fullscreen-content backdrop-blur-sm" data-streamdown="mermaid-fullscreen" initial="hidden" animate="visible" variants={opacity} transition={{ opacity: motionTokens().quick }}>{content}</motionElement.div>
      </LazyMotion>
    </Dialog.Popup>
    : <Presence>{open && <motionElement.div
      key="fullscreen"
      className="backdrop-blur-sm"
      data-streamdown="mermaid-fullscreen"
      initial="hidden"
      animate="visible"
      exit="hidden"
      variants={opacity}
      onAnimationComplete={(state: AnimationDefinition) => { if (state === "hidden") actions.current?.unmount(); }}
    >
      <Dialog.Popup className="diagram-fullscreen-popup" aria-label="View fullscreen">{content}</Dialog.Popup>
    </motionElement.div>}</Presence>;
  const dialogState = CSS_FULLSCREEN ? {} : {
    open,
    actionsRef: actions,
    onOpenChange: (next, event) => {
      if (!next) event.preventUnmountOnClose();
      setOpen(next);
    },
  } satisfies Dialog.Root.Props;
  return (
    <Dialog.Root {...dialogState}>
      <div className="reply-diagram">
        <StreamdownContext.Provider value={inline}><Code {...props} /></StreamdownContext.Provider>
        <Dialog.Trigger className="diagram-fullscreen-trigger" aria-label="View fullscreen" disabled={context.isAnimating}>
          <Maximize2 size={14} aria-hidden />
        </Dialog.Trigger>
      </div>
      <Dialog.Portal keepMounted={!CSS_FULLSCREEN} container={typeof context.portal === "function" ? context.portal() : context.portal ?? undefined}>
        {fullscreen}
      </Dialog.Portal>
    </Dialog.Root>
  );
}
