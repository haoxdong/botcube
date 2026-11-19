"use client";

import { useContext, useEffect, useLayoutEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LazyMotion, domMax, m } from "motion/react";
import { Pencil, X } from "lucide-react";
import { USER_MESSAGE_CLASS } from "./bubble-width";
import { Fade, GridCollapse, Presence, useInstant } from "./collapse";
import { motionTokens } from "./motion-tokens";
import { sentFilesOf } from "./composer-files";
import { MessageEntranceHistory } from "./message-entrance";
import type { PendingMessage, Withdrawal } from "./steering";

export const SHOWS_WAITING_STEERING = process.env.NEXT_PUBLIC_WAITING_STEERING === "1";
const SHOWS_SEND_NOW = process.env.NEXT_PUBLIC_SEND_NOW === "1";

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
  onSendNow: (() => void) | undefined;
  onEdit: () => void;
  onCancel: () => void;
  outcome: Withdrawal | undefined;
}) {
  const text = textOf(message.content);
  const sent = outcome === "taken" || message.now === true;
  const instant = useInstant();
  const { move, quick } = motionTokens();
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!shown && instant) onClosed();
  }, [shown, instant, onClosed]);
  // A closing row gives up one gap (--space-24, waiting-steering.css) as it folds: one before the last cancels the next
  // row's with its bottom margin; the last folds its own top margin away.
  const closed = () => last
    ? { height: 0, opacity: 0, marginTop: 0 }
    : { height: 0, opacity: 0, marginBottom: -parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-24")) };
  return (
    <m.div
      data-copilotkit
      className="copilotKitMessage copilotKitUserMessage cpk:flex cpk:flex-col cpk:items-end cpk:group cpk:pt-10 waiting-message"
      data-waiting-id={message.id}
      data-open={open || hovered ? "" : undefined}
      onPointerEnter={(event: ReactPointerEvent<HTMLDivElement>) => setHovered(event.pointerType === "mouse")}
      onPointerLeave={() => setHovered(false)}
      inert={shown ? undefined : true}
      style={{ overflow: shown ? undefined : "hidden" }}
      initial={false}
      animate={shown || instant ? { opacity: 1 } : closed()}
      transition={{ height: move, marginTop: move, marginBottom: move, opacity: quick }}
      {...(shown || instant ? {} : { onAnimationComplete: onClosed })}
    >
      <div className={`${USER_MESSAGE_CLASS} waiting-message-bubble`} onClick={sent ? undefined : () => { if (!matchMedia("(hover: hover)").matches) onToggle(); }}>{text}</div>
      <GridCollapse open={!sent} appear={false}>
        <div className="waiting-message-actions">
          <Fade open={outcome === "failed"} className="waiting-message-note">Your message is still waiting.</Fade>
          <span className="waiting-message-swap">
            <Presence>{onSendNow && (
              <m.span key="send-now" exit={{ opacity: 0 }}>
                <button type="button" className="waiting-message-send-now" onClick={onSendNow}>Send now</button>
              </m.span>
            )}</Presence>
            <span className="waiting-message-icons">
              <button type="button" className="waiting-message-icon" aria-label={`Edit ${text}`} onClick={onEdit}><Pencil aria-hidden="true" /></button>
              <button type="button" className="waiting-message-icon" aria-label={`Cancel ${text}`} onClick={onCancel}><X aria-hidden="true" /></button>
            </span>
          </span>
        </div>
      </GridCollapse>
    </m.div>
  );
}

export function WaitingMessages({ waiting, withdraw, sendNow, onEdit }: {
  waiting: PendingMessage[];
  withdraw: (id: string) => Promise<Withdrawal>;
  sendNow: ((id: string) => Promise<Withdrawal>) | undefined;
  onEdit: (message: PendingMessage) => void;
}) {
  const entrances = useContext(MessageEntranceHistory);
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
  const send = SHOWS_SEND_NOW ? sendNow : undefined;
  const rows = rowsOf(waiting, closing);
  const closed = (id: string) => () => setClosing((now) => {
    const next = new Map(now);
    next.delete(id);
    return next;
  });
  return (
    <LazyMotion features={domMax} strict>
      {rows.map(({ message, shown }, index) => (
          <WaitingMessage
            key={message.id}
            message={message}
            shown={shown}
            last={index === rows.length - 1}
            onClosed={closed(message.id)}
            open={open === message.id}
            onToggle={() => setOpen(open === message.id ? null : message.id)}
            onSendNow={send && (() => void act(message, send, false))}
            onEdit={() => void act(message, withdraw, true).then((outcome) => outcome === "withdrawn" && onEdit(message))}
            onCancel={() => void act(message, withdraw, true)}
            outcome={outcomes.get(message.id)}
          />
      ))}
    </LazyMotion>
  );
}
