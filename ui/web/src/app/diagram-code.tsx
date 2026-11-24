"use client";

import { Maximize2 } from "lucide-react";
import { isValidElement, useContext, type ComponentProps } from "react";
import { defaultComponents, StreamdownContext, type StreamdownContextType } from "streamdown";

import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { OpenFence } from "./reply-turn";

type CodeProps = ComponentProps<typeof defaultComponents.code>;
const Code = defaultComponents.code;

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
    <div className="my-4 flex w-full flex-col rounded-xl border border-(--color-line)" data-streamdown="mermaid-block" data-pending="">
      <div className="flex items-center text-(--color-text-muted) text-xs"><span className="ml-1 font-mono lowercase">mermaid</span></div>
      <div />
    </div>
  );
}

/** A finished diagram, with a control that opens it in a stock Dialog sized to the window. */
function DiagramCode(props: CodeProps) {
  const context = useContext<StreamdownContextType>(StreamdownContext);
  const controls = typeof context.controls === "object" ? context.controls : {};
  const mermaid = typeof controls.mermaid === "object" ? controls.mermaid : {};
  if (context.controls === false || controls.mermaid === false || mermaid.fullscreen === false) return <Code {...props} />;
  const inline = { ...context, controls: { ...controls, mermaid: { ...mermaid, fullscreen: false } } };
  const diagram = <StreamdownContext.Provider value={inline}><Code {...props} /></StreamdownContext.Provider>;
  return (
    <Dialog>
      <div className="reply-diagram">
        {diagram}
        <DialogTrigger className="diagram-fullscreen-trigger" aria-label="View fullscreen" disabled={context.isAnimating}>
          <Maximize2 size={14} aria-hidden />
        </DialogTrigger>
      </div>
      <DialogContent className="diagram-fullscreen-popup h-[calc(100%-2rem)] sm:max-w-[calc(100%-2rem)]" aria-label="View fullscreen" data-streamdown="mermaid-fullscreen">
        {diagram}
      </DialogContent>
    </Dialog>
  );
}
