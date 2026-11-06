import type { KeyboardEvent, RefObject } from "react";

const composing = (event: KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

export function holdEnter(held: boolean, isRunning: boolean, sendFiles?: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing(event)) return;
    if (event.key === "Enter" && !event.shiftKey && (held || sendFiles || (isRunning && !event.currentTarget.value.trim()))) {
      event.preventDefault();
      event.stopPropagation();
      if (!held) sendFiles?.();
    }
  };
}

export function stopOnEscapeNoMenuTook(stop: RefObject<(() => void) | null>) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || composing(event) || stop.current === null) return;
    event.preventDefault();
    stop.current();
  };
}
