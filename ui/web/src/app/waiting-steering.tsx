"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { CollapseList, FadeItem } from "./collapse";
import { sentFilesOf } from "./composer-files";
import type { PendingMessage } from "./steering";

export const SHOWS_WAITING_STEERING = process.env.NEXT_PUBLIC_WAITING_STEERING === "1";

function lineOf(content: string): string {
  const { text, paths } = sentFilesOf(content);
  return text.trim() || paths.map((path) => path.split("/").pop()).join(", ");
}

export function WaitingSteering({ waiting, onCancel, onEdit }: {
  waiting: PendingMessage[];
  onCancel: (message: PendingMessage) => void;
  onEdit: (message: PendingMessage) => void;
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
                  <button type="button" className="composer-waiting-text" title="Edit" onClick={() => onEdit(message)}>{line}</button>
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
