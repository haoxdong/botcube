"use client";

import { Swap, Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "framer-motion";

import { Dialog } from "@base-ui/react/dialog";
import type { HighlightResult } from "@streamdown/code";
import { CheckIcon, CopyIcon, X } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import { Sheet } from "../components/ui/sheet";
import { CodeWords } from "./code-words";
import { useIsPhone } from "./phone-query";
import { SHIKI_THEMES } from "./shiki-themes";

type Section = { label: string; text: string; look: "prose" | "shell" | "code"; badge?: string | undefined };

const SNAP_POINTS = [0.6, 1];

function sectionsOf({ name, params, output, exit, prose }: StepData): Section[] {
  const { description, ...rest } = params ?? {};
  const [only, ...more] = Object.values(rest);
  const command = name === "execute" && typeof rest.command === "string" ? rest.command : undefined;
  const single = more.length === 0 && typeof only === "string" ? only : undefined;
  const input = command ?? single ?? (only === undefined ? undefined : JSON.stringify(rest, null, 2));
  const inputLook = command !== undefined ? "shell" : prose && single !== undefined ? "prose" : "code";
  const sections: (Section | false)[] = [
    typeof description === "string" && description !== input && { label: "Description", text: description, look: "prose" },
    input !== undefined && { label: command === undefined ? "Input" : "Command", text: input, look: inputLook },
    Boolean(output || exit) && { label: "Output", text: output ?? "", look: "code", badge: exit && `Exit ${exit}` },
  ];
  return sections.filter((section) => section !== false);
}

type StepData = {
  name: string;
  params: Record<string, unknown> | undefined;
  output: string | undefined;
  exit: string | undefined;
  prose: boolean | undefined;
};

/** A tool call's sheet, or a thought's: its reasoning exactly as the provider returned it, in sans. */
type StepSheetProps = (StepData | { summary: string }) & { open: boolean; onClose: () => void; title: string };

export function StepSheet(props: StepSheetProps) {
  const { open, onClose, title } = props;
  const phone = useIsPhone();
  const sections: Section[] = "summary" in props ? [{ label: "Reasoning", text: props.summary, look: "prose" }] : sectionsOf(props);
  const body = (
    <div className="step-sheet-body">
      {sections.map((section) => <StepSection key={section.label} {...section} />)}
    </div>
  );
  if (phone) {
    return <Sheet open={open} onClose={onClose} title={title} container={null} snapPoints={SNAP_POINTS} className="step-sheet">{body}</Sheet>;
  }
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="step-popup-backdrop" />
        <Dialog.Popup className="step-popup">
          <div className="sheet-head">
            <Dialog.Close className="header-btn sheet-close" aria-label="Close">
              <X size={20} aria-hidden />
            </Dialog.Close>
            <Dialog.Title className="sheet-title">{title}</Dialog.Title>
          </div>
          {body}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StepSection({ label, text, look, badge }: Section) {
  return (
    <section className="step-section">
      <div className="step-section-head">
        <h3 className="step-section-label">{label}</h3>
        <Presence>{badge && <motionElement.span {...presenceMotion} className="step-section-exit">{badge}</motionElement.span>}</Presence>
        <Copy label={label} text={text} />
      </div>
      <pre className="step-section-text" data-prose={look === "prose" || undefined}><Swap as="span" state={look}>{look === "prose" ? text : look === "shell" ? <Shell text={text} /> : <CodeWords text={text} />}</Swap></pre>
    </section>
  );
}

function Copy({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<{ status: "idle" | "failed" } | { status: "copied"; text: string }>({ status: "idle" });
  useEffect(() => {
    if (state.status !== "copied") return undefined;
    const timer = setTimeout(() => setState({ status: "idle" }), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const Icon = state.status === "copied" && state.text === text ? CheckIcon : CopyIcon;
  return (
    <>
      <button type="button" className="header-btn step-section-copy" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void navigator.clipboard.writeText(text).then(
        () => setState({ status: "copied", text }),
        () => setState({ status: "failed" }),
      )}>
        <Icon size={14} aria-hidden />
      </button>
      <Presence>{state.status === "failed" && <motionElement.span {...presenceMotion} className="step-copy-error" role="alert">Copy failed. Select the text to copy it manually, or try again.</motionElement.span>}</Presence>
    </>
  );
}

// Shiki loads only once a command shows, outside the chat's first-load budget (web-cold-open-check.mjs). @streamdown/code
// returns the tokens at once when its highlighter has loaded, else later through the callback.
function Shell({ text }: { text: string }) {
  const [highlighted, setHighlighted] = useState<{ text: string; result: HighlightResult } | null>(null);
  useEffect(() => {
    let current = true;
    const show = (result: HighlightResult) => {
      if (current) setHighlighted({ text, result });
    };
    void import("@streamdown/code").then(({ code }) => {
      const ready = code.highlight({ code: text, language: "bash", themes: SHIKI_THEMES }, show);
      if (ready) show(ready);
    });
    return () => {
      current = false;
    };
  }, [text]);
  if (highlighted?.text !== text) return <code><CodeWords text={text} /></code>;
  return (
    <code>
      {highlighted.result.tokens.map((line, row) => (
        <span key={row}>
          {row > 0 && "\n"}
          {line.map((token) => <span key={token.offset} style={{ "--sdm-c": token.htmlStyle?.color ?? token.color } as CSSProperties}><CodeWords text={token.content} /></span>)}
        </span>
      ))}
    </code>
  );
}
