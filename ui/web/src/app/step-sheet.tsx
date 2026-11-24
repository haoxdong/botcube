"use client";



import { Arrives, Fades } from "./motion";

import type { HighlightResult } from "@streamdown/code";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Sheet } from "../components/ui/sheet";
import { CodeWords } from "./code-words";
import KeptMarkdown from "./kept-markdown";
import { useViewport } from "@/design-system/viewport";
import { SHIKI_THEMES } from "./shiki-themes";
import { Button } from "@/components/ui/button";
import { AlertLine } from "./alert-line";

type Section = { label: string; text: string; look: "prose" | "markdown" | "shell" | "code"; heading?: string | undefined; badge?: string | undefined };

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

type StepSheetProps = (StepData | { summary: string; heading: string | undefined }) & { open: boolean; onClose: () => void; title: string };

export function StepSheet(props: StepSheetProps) {
  const { open, onClose, title } = props;
  const phone = useViewport() === "phone";
  const sections: Section[] = "summary" in props ? [{ label: "Reasoning", text: props.summary, look: "markdown", heading: props.heading }] : sectionsOf(props);
  const body = (
    <div className="step-sheet-body">
      {sections.map((section) => <StepSection key={section.label} {...section} />)}
    </div>
  );
  if (phone) {
    return <Sheet open={open} onClose={onClose} title={title} container={null} snapPoints={SNAP_POINTS} className="step-sheet">{body}</Sheet>;
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="step-popup flex max-h-[80vh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function StepSection({ label, text, look, heading, badge }: Section) {
  return (
    <section className="step-section">
      <div className="step-section-head">
        <h3 className="step-section-label">{label}</h3>
        <Fades>{badge && <span className="step-section-exit">{badge}</span>}</Fades>
        <Copy label={label} text={text} />
      </div>
      <Arrives state={look}>{look === "markdown" ? (
        <div className="step-section-text" data-prose>
          <Arrives state={heading ?? ""}>{heading === undefined ? <KeptMarkdown text={text} /> : (
            <div className="space-y-4 whitespace-normal">
              <p><strong className="font-semibold">{heading}</strong></p>
              <KeptMarkdown text={text.slice(heading.length + 4)} />
            </div>
          )}</Arrives>
        </div>
      ) : (
        <pre className="step-section-text" data-prose={look === "prose" || undefined}><Arrives as="span" state={look}>{look === "prose" ? text : look === "shell" ? <Shell text={text} /> : <CodeWords text={text} />}</Arrives></pre>
      )}</Arrives>
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
      <Button type="button" variant="ghost" size="icon" className="step-section-copy" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void navigator.clipboard.writeText(text).then(
        () => setState({ status: "copied", text }),
        () => setState({ status: "failed" }),
      )}>
        <Icon size={14} aria-hidden />
      </Button>
      <Fades>{state.status === "failed" && <AlertLine className="step-copy-error">Copy failed. Select the text to copy it manually, or try again.</AlertLine>}</Fades>
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
