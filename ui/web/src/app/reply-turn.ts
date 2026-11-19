"use client";

import { createContext } from "react";

export const ReplyTurnRunning = createContext(false);

/** The code of the fence a running reply has opened and not yet closed, or null. */
export const OpenFence = createContext<string | null>(null);

/** The code of `content`'s last fence when nothing closes it, as CommonMark reads a fence. */
export function openFence(content: string): string | null {
  let fence: { mark: string; code: string[] } | null = null;
  for (const line of content.split("\n")) {
    const [, mark = "", info = ""] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
    if (fence === null) {
      if (mark && !(mark.startsWith("`") && info.includes("`"))) fence = { mark, code: [] };
    } else if (mark.startsWith(fence.mark.charAt(0)) && mark.length >= fence.mark.length && info.trim() === "") {
      fence = null;
    } else {
      fence.code.push(line);
    }
  }
  return fence && fence.code.join("\n");
}
