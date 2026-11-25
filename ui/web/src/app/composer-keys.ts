import type { KeyboardEvent, RefObject } from "react";

const composing = (event: KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || composing(event)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

export function stopOnEscapeNoMenuTook(stop: RefObject<(() => void) | null>) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || composing(event) || stop.current === null) return;
    event.preventDefault();
    stop.current();
  };
}
