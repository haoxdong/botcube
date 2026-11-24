import { createContext, useContext } from "react";
import { CLOCKS_KEPT, clockOf, spanOf, stampsOf, startOf, useServerClock, useWorklogClock, type Stamped, type WorklogClock } from "./worklog-clock";
import { withStorage } from "./main-chat-copy";

/** A message as the timeline reads it. */
type TimelineMessage = Stamped & { id: string; role: string; content?: unknown; toolCalls?: readonly { id: string; metadata?: Record<string, unknown> }[] | undefined };

/** A step of a Turn's work on its timeline: when it began here (live) and when it ended, or neither while unknown. A note is text a tool call followed. */
export type TimedStep = { id: string; timingId?: string; kind: "start" | "thought" | "tool" | "note" | "answer"; began?: number | undefined; ended: number | undefined; finished?: boolean };

/** "9s", "1m 12s". */
export const seconds = (whole: number) => (whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`);

type ObservedStep = { started: number; ended?: number };
type TurnTiming = { start: number; ended?: number | undefined; observed: Record<string, ObservedStep>; allocations: Record<string, Record<string, number>> };
const TIMINGS_KEY = "botcube.worklog-turns";
let timings: Map<string, TurnTiming> | undefined;

function timingOf(id: string, start: number, running: boolean, advanceClock: boolean) {
  timings ??= new Map(withStorage(() => JSON.parse(sessionStorage.getItem(TIMINGS_KEY) ?? "[]") as [string, TurnTiming][]) ?? []);
  const kept = timings.get(id);
  if (kept || !running || !advanceClock) return advanceClock ? kept : kept && structuredClone(kept);
  const current: TurnTiming = { start, observed: {}, allocations: {} };
  timings.set(id, current);
  const oldest = timings.keys().next().value;
  if (timings.size > CLOCKS_KEPT && oldest !== undefined) timings.delete(oldest);
  return current;
}

function stepSeconds(start: number, steps: readonly TimedStep[], now: number, running: boolean, kept?: TurnTiming, recordedEnd?: number, canonical = false): { total: number; each: Map<string, number> } {
  let reached = start;
  const each = new Map<string, number>();
  for (const [index, { id, ended, finished }] of steps.entries()) {
    const next = steps[index + 1];
    const end = Math.max(reached, canonical ? next?.began ?? reached : reached, ended ?? (finished ? reached : now), next === undefined ? (running ? now : recordedEnd ?? kept?.ended ?? reached) : reached);
    const bounded = recordedEnd === undefined ? end : Math.max(reached, Math.min(end, recordedEnd));
    each.set(id, Math.round((bounded - start) / 1000) - Math.round((reached - start) / 1000));
    reached = bounded;
  }
  return { total: Math.round((reached - start) / 1000), each };
}

function retainSeconds(timed: ReturnType<typeof stepSeconds>, kept: Record<string, number> | undefined, steps: readonly TimedStep[]) {
  if (!kept) return timed;
  const identity = (id: string) => steps.find(step => step.id === id)?.timingId ?? id;
  const each = new Map([...timed.each.keys()].map((id) => [id, kept[identity(id)] ?? 0]));
  const retained = [...each.values()].reduce((sum, value) => sum + value, 0);
  const total = Math.max(timed.total, retained);
  let remaining = total - retained;
  for (const [id, target] of timed.each) {
    const previous = each.get(id) ?? 0;
    const added = Math.min(remaining, Math.max(0, target - previous));
    remaining -= added;
    kept[identity(id)] = previous + added;
    each.set(id, previous + added);
  }
  return { total, each };
}

function allocationFor(kept: TurnTiming | undefined, viewId: string, steps: readonly TimedStep[]) {
  if (!kept) return undefined;
  if (kept.allocations[viewId]) return kept.allocations[viewId];
  const first = steps.find((step) => step.kind !== "start");
  const startId = steps.find((step) => step.kind === "start")?.id;
  const previous = first && Object.keys(kept.allocations).find((key) => Object.keys(kept.allocations[key] ?? {}).find((id) => id !== startId) === (first.timingId ?? first.id));
  const allocation = (previous === undefined ? undefined : kept.allocations[previous]) ?? {};
  if (previous !== undefined) delete kept.allocations[previous];
  kept.allocations[viewId] = allocation;
  return allocation;
}

const hasText = (message: TimelineMessage) => typeof message.content === "string" && message.content.trim() !== "";

function observedStep(kept: TurnTiming | undefined, id: string, running: boolean, now: number) {
  if (!kept) return undefined;
  const previous = kept.observed[id];
  if (previous) {
    if (!running) previous.ended ??= now;
    return previous;
  }
  if (!running) return undefined;
  return kept.observed[id] = { started: now };
}

function stepsOf(turn: readonly TimelineMessage[], startId: string, running: boolean, kept: TurnTiming | undefined, now: number): TimedStep[] {
  const lastCall = turn.findLastIndex((message) => message.toolCalls?.length);
  const said = (message: TimelineMessage) => message.role === "assistant" && !message.toolCalls?.length && hasText(message);
  const answer = turn.filter((message, index) => said(message) && index > lastCall).at(-1);
  const work = turn.flatMap((message, index): TimedStep[] => {
    const next = !running ? turn.slice(index + 1).find((candidate) => candidate.role !== "tool" && stampsOf(candidate) !== undefined) : undefined;
    const observedEnd = (next && stampsOf(next)?.[0]) ?? now;
    if (said(message) && index < lastCall) {
      const clock = observedStep(kept, message.id, false, observedEnd);
      return [{ id: message.id, kind: "note", finished: clock === undefined, began: stampsOf(message)?.[0] ?? clock?.started, ended: stampsOf(message)?.[1] ?? (!running && next ? stampsOf(next)?.[0] : undefined) ?? clock?.ended }];
    }
    if (message.role === "reasoning") {
      const clock = observedStep(kept, message.id, running && message === turn.at(-1), observedEnd);
      return [{ id: message.id, kind: "thought", finished: clock === undefined && message !== turn.at(-1), began: stampsOf(message)?.[0] ?? clock?.started, ended: stampsOf(message)?.[1] ?? (!running && next ? stampsOf(next)?.[0] : undefined) ?? clock?.ended }];
    }
    return (message.toolCalls ?? []).map((call) => {
      const result = turn.find((other) => other.role === "tool" && other.toolCallId === call.id);
      const clock = observedStep(kept, call.id, running && result === undefined, (result && stampsOf(result)?.[1]) ?? observedEnd);
      return { id: call.id, kind: "tool", finished: clock === undefined && result !== undefined, began: stampsOf(message)?.[0] ?? clock?.started, ended: running && !result ? undefined : (result && stampsOf(result)?.[1]) ?? (!running && result && next ? stampsOf(next)?.[0] : undefined) ?? clock?.ended };
    });
  });
  const answered: TimedStep[] = answer ? [{ id: answer.id, kind: "answer", began: stampsOf(answer)?.[0], ended: stampsOf(answer)?.[1] }] : [];
  const first = [...work, ...answered].find((step) => step.began !== undefined);
  return [{ id: startId, kind: "start", ended: first?.began }, ...work, ...answered];
}

function saveObservedTiming(kept: TurnTiming | undefined, advanceClock: boolean) {
  if (kept && advanceClock) withStorage(() => sessionStorage.setItem(TIMINGS_KEY, JSON.stringify([...timings ?? []])));
}

function knownTimeOf(kept: TurnTiming | undefined, turn: readonly TimelineMessage[] | undefined, fallback: number) {
  const start = kept?.start ?? startOf(turn ?? []) ?? fallback;
  const retained = Math.max(0, ...Object.values(kept?.allocations ?? {}).map((allocation) => Object.values(allocation).reduce((sum, value) => sum + value, 0)));
  return Math.max(start + retained * 1000, kept?.ended ?? start, ...(turn ?? []).flatMap((message) => stampsOf(message)?.[1] ?? []));
}

function finishedEndOf(turn: readonly TimelineMessage[] | undefined, running: boolean) {
  const last = turn?.at(-1);
  return !running && last?.role === "assistant" && !last.toolCalls?.length && hasText(last) ? stampsOf(last)?.[1] : undefined;
}

function canonicalSteps(steps: TimedStep[], turn: readonly TimelineMessage[], clock: WorklogClock): void {
  for (const step of steps) {
    const message = turn.find(message => message.id === step.id || message.toolCalls?.some(call => call.id === step.id));
    const call = message?.toolCalls?.find(call => call.id === step.id);
    const identity = call?.metadata?.timing_id ?? message?.metadata?.timing_id;
    step.timingId = typeof identity === "string" ? identity : step.id;
    const fact = clock.steps?.[step.timingId];
    const began = call?.metadata?.worklog_started_at;
    step.began = fact?.started_at ?? (typeof began === "number" ? began : step.began);
    step.ended = fact?.ended_at ?? step.ended;
  }
  const startup = steps[0];
  if (startup) startup.ended = steps.slice(1).find(step => step.began !== undefined)?.began;
}

function originOf(clock: WorklogClock | undefined, { turn, question, running, serverStart }: TurnSources, wall: number) {
  const liveNow = clock?.at ?? (clock ? knownTimeOf(undefined, turn, clock.started_at ?? startOf(turn ?? []) ?? wall) : wall);
  const sent = (question && stampsOf(question)?.[0]) ?? (running && serverStart !== undefined ? Date.parse(serverStart) : undefined);
  return { liveNow, origin: clock?.started_at ?? sent ?? startOf(turn ?? []) };
}

/** `serverClock`: the Chat Service's live clock; `serverStart`: its `runningSince`; `advanceClock: false`: a still view. */
export type TurnSources = { turn?: readonly TimelineMessage[] | undefined; question?: TimelineMessage | undefined; running: boolean; serverClock?: WorklogClock | undefined; serverStart?: string | undefined; viewId?: string | undefined; advanceClock?: boolean | undefined };
export type ClockedStep = TimedStep & { seconds: number };
/** A Turn's whole seconds (none if untimed), its steps summing to them, and whether it ended. */
export type TurnTime = { total: number | undefined; steps: readonly ClockedStep[]; settled: boolean };

/**
 * The one owner of which time source wins for the Turn answering `id`: the Chat Service's clock (live, else recorded on
 * the question), then message stamps, `runningSince`, this tab's allocations, and `now`. `ticks`: its times move with `now`.
 */
export function turnClock(id: string, sources: TurnSources) {
  const { turn, question, running, serverClock, viewId = id, advanceClock = true } = sources;
  const clock = serverClock ?? clockOf(question?.metadata?.worklog_clock);
  const canonical = clock?.version === 1 && !clock.pending;
  const untimed = (): TurnTime => {
    const span = spanOf(turn ?? []);
    return { total: span === undefined ? (running ? 0 : undefined) : Math.round(span / 1000), steps: [], settled: !running };
  };
  return {
    ticks: running && advanceClock && clock === undefined,
    at(wall: number): TurnTime {
      const { liveNow, origin } = originOf(clock, sources, wall);
      const kept = timingOf(id, origin ?? liveNow, running, advanceClock);
      if (kept && origin !== undefined) kept.start = canonical ? origin : Math.min(kept.start, origin);
      const start = kept?.start ?? origin;
      if (start === undefined) return untimed();
      const now = advanceClock ? liveNow : knownTimeOf(kept, turn, origin ?? liveNow);
      const recordedEnd = clock?.ended_at ?? finishedEndOf(turn, running);
      if (kept) kept.ended = running ? undefined : recordedEnd ?? kept.ended ?? now;
      if (!turn?.length) return { total: Math.round(((kept?.ended ?? now) - start) / 1000), steps: [], settled: !running };
      const startId = `${id}-started-up`;
      const steps = stepsOf(turn, startId, running, canonical ? undefined : kept, recordedEnd ?? now).map((step) => (step.kind === "answer" && step.ended === undefined && !running ? { ...step, ended: kept?.ended } : step));
      if (canonical) canonicalSteps(steps, turn, clock);
      if (!canonical && !running && !kept && steps.some((step) => step.ended === undefined)) return untimed();
      const { total, each } = retainSeconds(stepSeconds(start, steps, now, running, kept, canonical ? recordedEnd ?? now : recordedEnd, canonical), allocationFor(kept, viewId, steps), steps);
      saveObservedTiming(kept, advanceClock);
      return { total, steps: steps.filter((step) => step.id !== startId || each.get(startId)).map((step) => ({ ...step, seconds: each.get(step.id) ?? 0 })), settled: !running };
    },
  };
}

export const TurnStart = createContext<string | undefined>(undefined);

/** The Turn's times now, re-read each second while they tick. */
export function useTurnTime(id: string, sources: Omit<TurnSources, "serverClock" | "serverStart">): TurnTime {
  const clock = turnClock(id, { ...sources, serverClock: useServerClock(id), serverStart: useContext(TurnStart) });
  useWorklogClock(clock.ticks);
  return clock.at(Date.now());
}
