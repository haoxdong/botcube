"use client";

import "./native-reading.css";

import { inView } from "framer-motion";
import { createContext, useContext, useLayoutEffect, useState, type CSSProperties } from "react";

import { zoomOf } from "@/lib/utils";

export const NATIVE_READING = process.env.NEXT_PUBLIC_NATIVE_READING === "1";
export const ReadingState = createContext<{ active: boolean; setActive: (active: boolean) => void } | null>(null);

type Size = { width: number; height: number };

/** Reserve the size a row or its content had as it entered the upper half of the view. */
export function useReadingSize(target: Element | string | null, part: "row" | "content" = "row") {
  const reading = useContext(ReadingState);
  const active = NATIVE_READING && reading?.active === true;
  const [size, setSize] = useState<Size>();
  useLayoutEffect(() => {
    setSize(undefined);
    if (!active || target === null) return;
    const observed = typeof target === "string" ? `.copilotKitMessage[data-message-id="${CSS.escape(target)}"]${part === "content" ? " .chat-markdown" : ""}` : target;
    return inView(observed, (element, entry) => {
      const zoom = zoomOf(element);
      setSize({ width: entry.boundingClientRect.width / zoom, height: entry.boundingClientRect.height / zoom });
      return () => setSize(undefined);
    }, { margin: `0px 0px ${-innerHeight / 2}px 0px` });
  }, [target, part, active]);
  return active ? size : undefined;
}

export function readingStyle(size: Size | undefined, part: "row" | "content" = "row"): CSSProperties | undefined {
  if (size === undefined) return undefined;
  const prefix = part === "content" ? "--reading-content" : "--reading";
  return { [`${prefix}-height`]: `${size.height}px`, [`${prefix}-width`]: `${size.width}px` };
}
