import { useCallback, useSyncExternalStore } from "react";

/** A replayed message as the clocks read it: its `started_at` and `ended_at` metadata, in epoch ms. */
export type Stamped = { role?: string; toolCallId?: string | undefined; metadata?: Record<string, unknown> | undefined };

export function stampsOf({ metadata }: Stamped): [started: number, ended: number] | undefined {
  const { started_at: started, ended_at: ended } = metadata ?? {};
  return typeof started === "number" && typeof ended === "number" ? [started, ended] : undefined;
}

/** When replayed messages started, at the first one's start; unstamped, nothing. */
export function startOf(messages: readonly Stamped[]): number | undefined {
  const starts = messages.flatMap((message) => stampsOf(message)?.[0] ?? []);
  return starts.length ? Math.min(...starts) : undefined;
}

/** How long replayed messages took, from the first one's start to the last one's end; unstamped, nothing. */
export function spanOf(messages: readonly Stamped[]): number | undefined {
  const started = startOf(messages);
  return started === undefined ? undefined : Math.max(...messages.flatMap((message) => stampsOf(message)?.[1] ?? [])) - started;
}

export const CLOCKS_KEPT = 100;

const listeners = new Set<() => void>();
let revision = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => revision;
const publish = () => {
  revision++;
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(publish, 1000);
    document.addEventListener("visibilitychange", publish);
    window.addEventListener("online", publish);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", publish);
    window.removeEventListener("online", publish);
  };
}

export function useWorklogClock(running: boolean): void {
  const observe = useCallback((listener: () => void) => running ? subscribe(listener) : () => undefined, [running]);
  useSyncExternalStore(observe, snapshot, snapshot);
}
