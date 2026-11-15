"use client";

import { Dialog } from "@base-ui/react/dialog";
import { m as motionElement, type AnimationDefinition } from "framer-motion";
import { Maximize2, X } from "lucide-react";
import { useContext, useRef, useState, type ComponentProps } from "react";
import { defaultComponents, StreamdownContext, type StreamdownContextType } from "streamdown";

import { Presence } from "./collapse";

type CodeProps = ComponentProps<typeof defaultComponents.code>;
const Code = defaultComponents.code;
const opacity = { hidden: { opacity: 0 }, visible: { opacity: 1 } };

export function ReplyCode(props: CodeProps) {
  return props.className?.split(" ").includes("language-mermaid") && "data-block" in props
    ? <DiagramCode {...props} />
    : <Code {...props} />;
}

function DiagramCode(props: CodeProps) {
  const context = useContext<StreamdownContextType>(StreamdownContext);
  const [open, setOpen] = useState(false);
  const actions = useRef<Dialog.Root.Actions | null>(null);
  const controls = typeof context.controls === "object" ? context.controls : {};
  const mermaid = typeof controls.mermaid === "object" ? controls.mermaid : {};
  if (context.controls === false || controls.mermaid === false || mermaid.fullscreen === false) return <Code {...props} />;
  const inline = { ...context, controls: { ...controls, mermaid: { ...mermaid, fullscreen: false } } };
  return (
    <Dialog.Root open={open} actionsRef={actions} onOpenChange={(next, event) => {
      if (!next) event.preventUnmountOnClose();
      setOpen(next);
    }}>
      <div className="reply-diagram">
        <StreamdownContext.Provider value={inline}><Code {...props} /></StreamdownContext.Provider>
        <Dialog.Trigger className="diagram-fullscreen-trigger" aria-label="View fullscreen" disabled={context.isAnimating}>
          <Maximize2 size={14} aria-hidden />
        </Dialog.Trigger>
      </div>
      <Dialog.Portal keepMounted container={typeof context.portal === "function" ? context.portal() : context.portal ?? undefined}>
        <Presence>{open && <motionElement.div
          key="fullscreen"
          className="backdrop-blur-sm"
          data-streamdown="mermaid-fullscreen"
          initial="hidden"
          animate="visible"
          exit="hidden"
          variants={opacity}
          onAnimationComplete={(state: AnimationDefinition) => { if (state === "hidden") actions.current?.unmount(); }}
        >
          <Dialog.Popup className="diagram-fullscreen-popup" aria-label="View fullscreen">
            <Dialog.Close className="diagram-fullscreen-close" aria-label="Exit fullscreen"><X size={20} aria-hidden /></Dialog.Close>
            <StreamdownContext.Provider value={inline}><Code {...props} /></StreamdownContext.Provider>
          </Dialog.Popup>
        </motionElement.div>}</Presence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
