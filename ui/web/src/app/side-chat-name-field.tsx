"use client";

import { useRef } from "react";

/** A Side Chat's name, edited in its row: Enter or leaving the field ends with its value, Escape with none. */
export function SideChatNameField({ title, onDone }: { title: string; onDone: (name: string | null) => void }) {
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="sidebar-item-name"
      aria-label="Side chat name"
      defaultValue={title}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
