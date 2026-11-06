import { useEffect, useState } from "react";

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

type Clock = { started: number; ended?: number };
// The clocks of live Turns, thoughts and tool calls, by id: they outlive the rows CopilotKit remounts as a chat's messages change.
// Each keeps only its newest clocks, enough for the ones a page shows.
export const turnClocks = new Map<string, Clock>();
export const thoughtClocks = new Map<string, Clock>();
export const CLOCKS_KEPT = 100;

/** Keeps `clock` as `id`'s newest, dropping the oldest past CLOCKS_KEPT. */
function keep(clocks: Map<string, Clock>, id: string, clock: Clock) {
  clocks.delete(id);
  clocks.set(id, clock);
  const [oldest] = clocks.keys();
  if (clocks.size > CLOCKS_KEPT && oldest !== undefined) clocks.delete(oldest);
}

/**
 * How long `id` has run here: from when it, or else `since`, first ran (else `startedAt`) until `running` ends, re-rendering each second.
 * A row remounted mid-run carries on from its kept start.
 */
export function useClock(clocks: Map<string, Clock>, id: string, running: boolean, since?: string, startedAt?: number): number | undefined {
  const [clock, setClock] = useState(() => clocks.get(id) ?? clocks.get(since ?? id));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const live = { started: Math.min((clocks.get(id) ?? clocks.get(since ?? id))?.started ?? Infinity, startedAt ?? Infinity, Date.now()) };
    keep(clocks, id, live);
    setClock(live);
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(timer);
      const ended = { ...live, ended: Date.now() };
      keep(clocks, id, ended);
      setClock(ended);
    };
  }, [clocks, id, running, since, startedAt]);
  return clock && (clock.ended ?? Date.now()) - clock.started;
}

export const toolClocks = new Map<string, Clock>();

/** Runs tool call `id`'s live clock while it runs, so its Worklog knows where its step ended. */
export function useToolClock(id: string | undefined, running: boolean): void {
  useClock(toolClocks, id ?? "", running && id !== undefined);
}
