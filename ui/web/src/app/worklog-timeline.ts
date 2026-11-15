import { CLOCKS_KEPT, stampsOf, startOf, type Stamped } from "./worklog-clock";
import { withStorage } from "./main-chat-copy";

/** A message as the timeline reads it. */
type TimelineMessage = Stamped & { id: string; role: string; content?: unknown; toolCalls?: readonly { id: string }[] | undefined };

/** A step of a Turn's work on its timeline: when it began here (live) and when it ended, or neither while unknown. */
export type TimedStep = { id: string; kind: "start" | "thought" | "tool" | "answer"; began?: number | undefined; ended: number | undefined; finished?: boolean };

/** "9s", "1m 12s". */
export const seconds = (whole: number) => (whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`);

type ObservedStep = { started: number; ended?: number };
type TurnTiming = { start: number; ended?: number | undefined; observed: Record<string, ObservedStep>; allocations: Record<string, Record<string, number>> };
const TIMINGS_KEY = "botcube.worklog-turns";
let timings: Map<string, TurnTiming> | undefined;

function timingOf(id: string, start: number, running: boolean) {
  timings ??= new Map(withStorage(() => JSON.parse(sessionStorage.getItem(TIMINGS_KEY) ?? "[]") as [string, TurnTiming][]) ?? []);
  const kept = timings.get(id);
  if (kept || !running) return kept;
  const current: TurnTiming = { start, observed: {}, allocations: {} };
  timings.set(id, current);
  const oldest = timings.keys().next().value;
  if (timings.size > CLOCKS_KEPT && oldest !== undefined) timings.delete(oldest);
  return current;
}

function stepSeconds(start: number, steps: readonly TimedStep[], now: number, running: boolean, kept?: TurnTiming): { total: number; each: Map<string, number> } {
  let reached = start;
  const each = new Map<string, number>();
  for (const [index, { id, ended, finished }] of steps.entries()) {
    const next = steps[index + 1];
    const end = Math.max(reached, ended ?? (finished ? reached : now), next === undefined ? (running ? now : kept?.ended ?? reached) : reached);
    each.set(id, Math.round((end - start) / 1000) - Math.round((reached - start) / 1000));
    reached = end;
  }
  return { total: Math.round((reached - start) / 1000), each };
}

function retainSeconds(timed: ReturnType<typeof stepSeconds>, kept: Record<string, number> | undefined) {
  if (!kept) return timed;
  const each = new Map([...timed.each.keys()].map((id) => [id, kept[id] ?? 0]));
  const retained = [...each.values()].reduce((sum, value) => sum + value, 0);
  const total = Math.max(timed.total, retained);
  let remaining = total - retained;
  for (const [id, target] of timed.each) {
    const previous = each.get(id) ?? 0;
    const added = Math.min(remaining, Math.max(0, target - previous));
    remaining -= added;
    kept[id] = previous + added;
    each.set(id, previous + added);
  }
  return { total, each };
}

function allocationFor(kept: TurnTiming | undefined, viewId: string, steps: readonly TimedStep[]) {
  if (!kept) return undefined;
  if (kept.allocations[viewId]) return kept.allocations[viewId];
  const first = steps.find((step) => step.kind !== "start");
  const startId = steps.find((step) => step.kind === "start")?.id;
  const previous = first && Object.keys(kept.allocations).find((key) => Object.keys(kept.allocations[key] ?? {}).find((id) => id !== startId) === first.id);
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
  const texts = turn.filter((message, index) => message.role === "assistant" && !message.toolCalls?.length && hasText(message) && index > lastCall);
  const answer = texts.at(-1) ?? turn.findLast((message) => message.role === "assistant" && !message.toolCalls?.length && hasText(message));
  const work = turn.flatMap((message): TimedStep[] => {
    if (message.role === "reasoning") {
      const clock = observedStep(kept, message.id, running && message === turn.at(-1), now);
      return [{ id: message.id, kind: "thought", finished: clock === undefined && message !== turn.at(-1), began: stampsOf(message)?.[0] ?? clock?.started, ended: stampsOf(message)?.[1] ?? clock?.ended }];
    }
    return (message.toolCalls ?? []).map((call) => {
      const result = turn.find((other) => other.role === "tool" && other.toolCallId === call.id);
      const clock = observedStep(kept, call.id, running && result === undefined, now);
      return { id: call.id, kind: "tool", finished: clock === undefined && result !== undefined, began: stampsOf(message)?.[0] ?? clock?.started, ended: running && !result ? undefined : (result && stampsOf(result)?.[1]) ?? clock?.ended };
    });
  });
  const answered: TimedStep[] = answer ? [{ id: answer.id, kind: "answer", began: stampsOf(answer)?.[0], ended: stampsOf(answer)?.[1] }] : [];
  const first = [...work, ...answered].find((step) => step.began !== undefined);
  return [{ id: startId, kind: "start", ended: first?.began }, ...work, ...answered];
}

/**
 * Allocates rounded Turn time in message order. Retains displayed allocations in this tab across replay and reload.
 * Untimed when a finished step lacks an end.
 */
export function timelineOf(id: string, turn: readonly TimelineMessage[] | undefined, question: TimelineMessage | undefined, running: boolean, serverStart: string | undefined, viewId = id) {
  const now = Date.now();
  const sent = (question && stampsOf(question)?.[0]) ?? (running && serverStart !== undefined ? Date.parse(serverStart) : undefined);
  const origin = sent ?? startOf(turn ?? []);
  const kept = timingOf(question?.id ?? id, origin ?? now, running);
  if (kept && origin !== undefined) kept.start = Math.min(kept.start, origin);
  const start = kept?.start ?? origin;
  if (start === undefined) return undefined;
  if (kept) kept.ended = running ? undefined : kept.ended ?? now;
  if (!turn?.length) return { total: Math.round(((kept?.ended ?? now) - start) / 1000), each: new Map<string, number>(), steps: [] };
  const startId = `${question?.id ?? id}-started-up`;
  const steps = stepsOf(turn, startId, running, kept, now).map((step) => (step.kind === "answer" && step.ended === undefined && !running ? { ...step, ended: kept?.ended } : step));
  if (!running && !kept && steps.some((step) => step.ended === undefined)) return undefined;
  const allocation = allocationFor(kept, viewId, steps);
  const timed = retainSeconds(stepSeconds(start, steps, now, running, kept), allocation);
  const shown = timed.each.get(startId) ? steps : steps.filter((step) => step.id !== startId);
  if (kept) withStorage(() => sessionStorage.setItem(TIMINGS_KEY, JSON.stringify([...timings ?? []])));
  return { ...timed, steps: shown };
}

/** The Worklog's step of `kind`, with its spoken time, if its timeline has one. */
export function stepOf(timeline: ReturnType<typeof timelineOf>, kind: TimedStep["kind"]): { id: string; time: string } | undefined {
  const step = timeline?.steps.find((candidate) => candidate.kind === kind);
  return step && { id: step.id, time: seconds(timeline?.each.get(step.id) ?? 0) };
}

/** The Worklog's time from its Turn allocation, else the supplied message span. */
export function totalOf(timeline: ReturnType<typeof timelineOf>, time: number | undefined): string | undefined {
  if (timeline) return seconds(timeline.total);
  return time === undefined ? undefined : seconds(Math.round(time / 1000));
}
