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

export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || composing(event)) return;
  event.preventDefault();
  const form = event.currentTarget.form;
  if (form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled) return;
  form?.requestSubmit();
}

export function stopOnEscapeNoMenuTook(stop: RefObject<(() => void) | null>) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || composing(event) || stop.current === null) return;
    event.preventDefault();
    stop.current();
  };
}
