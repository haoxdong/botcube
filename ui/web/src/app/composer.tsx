"use client";

import { useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { Arrives } from "./motion";
import { ArrowUp, Square } from "lucide-react";
import { submitOnEnter } from "./composer-keys";
import { viewport } from "@/design-system/viewport";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";

type Layout = "compact" | "expanded";

const measure = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");

const px = (value: string) => parseFloat(value) || 0;

function outerWidth(element: Element) {
  const style = getComputedStyle(element);
  return element.getBoundingClientRect().width + px(style.marginLeft) + px(style.marginRight);
}

function layoutFor(text: HTMLTextAreaElement, hasFiles: boolean): Layout {
  if (hasFiles || text.value.includes("\n")) return "expanded";
  const box = text.closest<HTMLElement>(".composer-box");
  const start = box?.querySelector(".composer-start");
  const end = box?.querySelector(".composer-end");
  if (!box || !start || !end || !measure || text.value === "") return "compact";
  const style = getComputedStyle(box);
  const picker = end.querySelector(".chat-model-picker");
  const pickerInPill = picker !== null && viewport() !== "phone";
  const endStyle = getComputedStyle(end);
  const controls = [...end.children].filter((child) => child !== picker || pickerInPill);
  const ends = controls.reduce((sum, child) => sum + outerWidth(child), 0) + px(endStyle.columnGap) * Math.max(controls.length - 1, 0)
    + px(endStyle.paddingLeft) + px(endStyle.paddingRight) + px(endStyle.marginLeft) + px(endStyle.marginRight);
  const column = box.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - outerWidth(start) - ends - 2 * px(style.columnGap);
  const textStyle = getComputedStyle(text);
  measure.font = textStyle.font;
  return measure.measureText(text.value).width > column - px(textStyle.paddingLeft) - px(textStyle.paddingRight) ? "expanded" : "compact";
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  hasFiles,
  autoFocus,
  addMenu,
  files,
  picker,
  disclaimer,
  onPaste,
  className,
  replica = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend?: (() => void) | undefined;
  onStop: (() => void) | undefined;
  running: boolean;
  hasFiles: boolean;
  autoFocus?: boolean | undefined;
  addMenu: ReactNode;
  files?: ReactNode;
  picker?: ReactNode;
  disclaimer: ReactNode;
  onPaste?: ((event: ClipboardEvent<HTMLTextAreaElement>) => void) | undefined;
  className?: string | undefined;
  /** An inert copy, as the kept chat draws: read-only and unnamed, so only the live composer is "Message". */
  replica?: boolean;
}) {
  const text = useRef<HTMLTextAreaElement>(null);
  const [layout, setLayout] = useState<Layout>("compact");
  useLayoutEffect(() => {
    if (text.current) setLayout(layoutFor(text.current, hasFiles));
  }, [value, hasFiles]);
  useLayoutEffect(() => {
    const check = () => { if (text.current) setLayout(layoutFor(text.current, hasFiles)); };
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [hasFiles]);
  useLayoutEffect(() => {
    if (autoFocus) text.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const stoppable = running && onStop !== undefined;
  return (
    <div data-copilotkit className="cpk:pointer-events-none cpk:relative z-(--layer-bar)" style={{ paddingBottom: "var(--copilotkit-license-banner-offset, 0px)" }}>
      <div className="cpk:max-w-3xl cpk:mx-auto cpk:py-0 cpk:px-4 cpk:@3xl:px-0 cpk:pointer-events-auto">
        <form
          className={className ? `w-full chat-composer ${className}` : "w-full chat-composer"}
          data-layout={layout}
          onSubmit={(event) => {
            event.preventDefault();
            if (!onSend) return;
            onSend();
            text.current?.focus();
          }}
        >
          <InputGroup className="composer-box">
            {files}
            <InputGroupAddon align="inline-start" className="composer-start">{addMenu}</InputGroupAddon>
            <InputGroupTextarea
              ref={text}
              className="field-sizing-content max-h-48 min-h-16 composer-text"
              name="message"
              data-testid="copilot-chat-textarea"
              aria-label={replica ? undefined : "Message"}
              readOnly={replica}
              placeholder="Ask anything"
              rows={1}
              value={value}
              onChange={(event) => onChange(event.currentTarget.value)}
              onKeyDown={submitOnEnter}
              onPaste={onPaste}
            />
            <InputGroupAddon align="inline-end" className="composer-end">
              {picker}
              <InputGroupButton
                className="composer-send rounded-full focus-visible:bg-(--color-text)/80"
                size="icon-sm"
                variant="default"
                data-testid="copilot-send-button"
                aria-label={running ? "Stop" : "Send"}
                disabled={running ? !stoppable : !onSend}
                {...(running ? { type: "button" as const, onClick: () => onStop?.() } : { type: "submit" as const })}
              >
                <Arrives as="span" state={running ? "stop" : "send"}>{running ? <Square className="size-3 fill-current" aria-hidden /> : <ArrowUp aria-hidden />}</Arrives>
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
      <div className="chat-disclaimer cpk:text-center cpk:py-3 cpk:px-4 cpk:max-w-3xl cpk:mx-auto">{disclaimer}</div>
    </div>
  );
}
