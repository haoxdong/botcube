"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pencil, X } from "lucide-react";
import { USER_MESSAGE_CLASS } from "./bubble-width";
import { Fold, foldAway, Shows } from "./motion";
import { sentFilesOf } from "./composer-files";
import { MessageEntranceContext } from "./message-entrance";
import type { PendingMessage, Withdrawal } from "./steering";
import { Button } from "@/components/ui/button";

type Closing = { message: PendingMessage; after: string | null };
type Row = { message: PendingMessage; shown: boolean };

function textOf(content: string): string {
  const { text, paths } = sentFilesOf(content);
  return text.trim() || paths.map((path) => path.split("/").pop()).join(", ");
}

function rowsOf(waiting: PendingMessage[], closing: Map<string, Closing>): Row[] {
  const rows = waiting.map((message) => ({ message, shown: true }));
  for (const { message, after } of closing.values()) {
    if (rows.some((row) => row.message.id === message.id)) continue;
    const before = after === null ? -1 : rows.findIndex((row) => row.message.id === after);
    rows.splice(after !== null && before === -1 ? rows.length : before + 1, 0, { message, shown: false });
  }
  return rows;
}

function useOpenRow(): [string | null, (id: string | null) => void] {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (open === null) return undefined;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(`[data-waiting-id="${CSS.escape(open)}"]`) === null) setOpen(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return [open, setOpen];
}

function WaitingMessage({ message, shown, last, onClosed, open, onToggle, onSendNow, onEdit, onCancel, outcome }: {
  message: PendingMessage;
  shown: boolean;
  last: boolean;
  onClosed: () => void;
  open: boolean;
  onToggle: () => void;
  onSendNow: () => void;
  onEdit: () => void;
  onCancel: () => void;
  outcome: Withdrawal | undefined;
}) {
  const text = textOf(message.content);
  const sent = outcome === "taken" || message.now === true;
  const [hovered, setHovered] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // A closing row gives up one gap (--space-24, waiting-steering.css) as it folds: one before the last cancels the next
  // row's with its bottom margin; the last folds its own top margin away.
  const closed = useRef(onClosed);
  useLayoutEffect(() => {
    closed.current = onClosed;
  });
  useLayoutEffect(() => {
    if (shown || row.current === null) return;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-24")) || 0;
    foldAway(row.current, () => closed.current(), last ? { marginTop: "0px" } : { marginBottom: `${-gap}px` });
  }, [shown, last]);
  return (
    <div
      ref={row}
      data-copilotkit
      className="copilotKitMessage copilotKitUserMessage cpk:flex cpk:flex-col cpk:items-end cpk:group cpk:pt-10 waiting-message"
      data-waiting-id={message.id}
      data-open={open || hovered ? "" : undefined}
      onPointerLeave={() => setHovered(false)}
      inert={shown ? undefined : true}
      style={{ overflow: shown ? undefined : "hidden" }}
    >
      <div className={`${USER_MESSAGE_CLASS} waiting-message-bubble`} onPointerEnter={(event: ReactPointerEvent<HTMLDivElement>) => setHovered(event.pointerType === "mouse")} onClick={sent ? undefined : () => { if (!matchMedia("(hover: hover)").matches) onToggle(); }}>{text}</div>
      <Fold open={!sent}><div className="waiting-message-actions">
          <Shows appear when={message.missed === true || outcome === "failed"} className="waiting-message-note" role="status">
            {message.missed ? "Waiting for the next Turn" : "Your message is still waiting."}
          </Shows>
          <span className="waiting-message-swap">
            <Button type="button" variant="ghost" size="sm" className="waiting-message-send-now" onClick={onSendNow}>Send now</Button>
            <span className="waiting-message-icons">
              <Button type="button" variant="ghost" size="icon-sm" className="waiting-message-icon" aria-label={`Edit ${text}`} onClick={onEdit}><Pencil aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-sm" className="waiting-message-icon" aria-label={`Cancel ${text}`} onClick={onCancel}><X aria-hidden="true" /></Button>
            </span>
          </span>
        </div></Fold>
    </div>
  );
}

export function WaitingMessages({ waiting, withdraw, sendNow, onEdit }: {
  waiting: PendingMessage[];
  withdraw: (id: string) => Promise<Withdrawal>;
  sendNow: (id: string) => Promise<Withdrawal>;
  onEdit: (message: PendingMessage) => void;
}) {
  const entrances = useContext(MessageEntranceContext);
  useLayoutEffect(() => {
    for (const { id } of waiting) entrances?.presentedMessage(id);
  }, [entrances, waiting]);
  const [open, setOpen] = useOpenRow();
  const [closing, setClosing] = useState(new Map<string, Closing>());
  const [outcomes, setOutcomes] = useState(new Map<string, Withdrawal>());
  const act = async (message: PendingMessage, request: (id: string) => Promise<Withdrawal>, closes: boolean) => {
    const after = waiting[waiting.findIndex(({ id }) => id === message.id) - 1]?.id ?? null;
    const outcome = await request(message.id);
    setOutcomes((now) => new Map(now).set(message.id, outcome));
    if (outcome !== "withdrawn" || !closes) return outcome;
    setClosing((now) => new Map(now).set(message.id, { message, after }));
    return outcome;
  };
  const rows = rowsOf(waiting, closing);
  const closed = (id: string) => () => setClosing((now) => {
    const next = new Map(now);
    next.delete(id);
    return next;
  });
  return (
    <>
      {rows.map(({ message, shown }, index) => (
          <WaitingMessage
            key={message.id}
            message={message}
            shown={shown}
            last={index === rows.length - 1}
            onClosed={closed(message.id)}
            open={open === message.id}
            onToggle={() => setOpen(open === message.id ? null : message.id)}
            onSendNow={() => void act(message, sendNow, false)}
            onEdit={() => void act(message, withdraw, true).then((outcome) => outcome === "withdrawn" && onEdit(message))}
            onCancel={() => void act(message, withdraw, true)}
            outcome={outcomes.get(message.id)}
          />
      ))}
    </>
  );
}
