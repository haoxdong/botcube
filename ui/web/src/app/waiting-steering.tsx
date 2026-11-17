"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import { m as motionElement } from "framer-motion";
import { X } from "lucide-react";
import { CollapseList, FadeItem, Presence, presenceMotion } from "./collapse";
import { sentFilesOf } from "./composer-files";
import type { PendingMessage } from "./steering";

export const SHOWS_WAITING_STEERING = process.env.NEXT_PUBLIC_WAITING_STEERING === "1";
const SHOWS_SEND_NOW = process.env.NEXT_PUBLIC_SEND_NOW === "1";

function lineOf(content: string): string {
  const { text, paths } = sentFilesOf(content);
  return text.trim() || paths.map((path) => path.split("/").pop()).join(", ");
}

function SendNow({ onSendNow }: { onSendNow: (() => void) | undefined }) {
  if (!onSendNow) return null;
  return <Popover.Close className="mep-option" onClick={onSendNow}><span className="mep-option-name">Send now</span></Popover.Close>;
}

type RowProps = { line: string; onSendNow: (() => void) | undefined; onEdit: () => void };

function RowButton({ line, onEdit }: RowProps) {
  return <button type="button" className="composer-waiting-text" title="Edit" onClick={onEdit}>{line}</button>;
}

function RowMenu({ line, onSendNow, onEdit }: RowProps) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger className="composer-waiting-text" nativeButton>{line}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="standard-popup-positioner" side="top" align="start" sideOffset={8}>
          <Popover.Popup ref={popup} initialFocus={(openType) => openType === "keyboard" || popup.current} className="mep-dropdown standard-popup composer-waiting-menu" aria-label={`Waiting message ${line}`}>
            <SendNow onSendNow={onSendNow} />
            <Popover.Close className="mep-option" onClick={onEdit}><span className="mep-option-name">Edit</span></Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const RowText = SHOWS_SEND_NOW ? RowMenu : RowButton;

export function WaitingSteering({ waiting, onCancel, onEdit, onSendNow }: {
  waiting: PendingMessage[];
  onCancel: (message: PendingMessage) => void;
  onEdit: (message: PendingMessage) => void;
  onSendNow: ((message: PendingMessage) => void) | undefined;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const [card, setCard] = useState<Element | null>(null);
  useLayoutEffect(() => setCard(marker.current?.parentElement?.querySelector(".copilotKitInput") ?? null), []);
  return (
    <>
      <span ref={marker} hidden />
      {card && createPortal(
        <ul className="composer-waiting" aria-label="Waiting messages">
          <CollapseList>
            {waiting.map((message) => {
              const line = lineOf(message.content);
              return (
                <FadeItem key={message.id} className="composer-waiting-row">
                  <RowText line={line} onSendNow={onSendNow && (() => onSendNow(message))} onEdit={() => onEdit(message)} />
                  <Presence>{SHOWS_SEND_NOW && message.missed && (
                    <motionElement.span {...presenceMotion} className="composer-waiting-label">After this reply</motionElement.span>
                  )}</Presence>
                  <button type="button" className="composer-file-remove" aria-label={`Cancel ${line}`} onClick={() => onCancel(message)}>
                    <X aria-hidden="true" />
                  </button>
                </FadeItem>
              );
            })}
          </CollapseList>
        </ul>,
        card,
      )}
    </>
  );
}
