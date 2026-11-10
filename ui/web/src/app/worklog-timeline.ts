import { stampsOf, startOf, thoughtClocks, toolClocks, turnClocks, type Stamped } from "./worklog-clock";

/** A message as the timeline reads it. */
type TimelineMessage = Stamped & { id: string; role: string; content?: unknown; toolCalls?: readonly { id: string }[] | undefined };

/** A step of a Turn's work on its timeline: when it began here (live) and when it ended, or neither while unknown. */
export type TimedStep = { id: string; kind: "start" | "thought" | "tool" | "answer"; began?: number | undefined; ended: number | undefined; finished?: boolean };

/** "9s", "1m 12s". */
export const seconds = (whole: number) => (whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`);

/** Whole seconds for spans summing to `total`, the leftover going to the largest remainders. */
function apportioned(spans: readonly { id: string; span: number }[], total: number): Map<string, number> {
  const each = new Map(spans.map(({ id, span }) => [id, Math.floor(span)]));
  let left = total - spans.reduce((sum, { span }) => sum + Math.floor(span), 0);
  for (const { id } of [...spans].sort((a, b) => (b.span % 1) - (a.span % 1))) {
    if (left <= 0) break;
    each.set(id, (each.get(id) ?? 0) + 1);
    left -= 1;
  }
  return each;
}

/**
 * Each step's whole seconds on one timeline from `start`: in the order the steps ended, each runs from the end before
 * it to its own. The finished steps round once, to the largest remainders; the running step, ended at `now`, takes the
 * rest of the rounded total, so the rows sum to it and a finished row never changes as the clock ticks.
 */
function stepSeconds(start: number, steps: readonly TimedStep[], now: number): { total: number; each: Map<string, number> } {
  let reached = start;
  const byEnd = [...steps].sort((a, b) => (a.ended ?? Infinity) - (b.ended ?? Infinity));
  const finished = byEnd.filter((step) => step.ended !== undefined || step.finished).map(({ id, ended = reached }) => {
    const span = Math.max(ended - reached, 0) / 1000;
    reached = Math.max(ended, reached);
    return { id, span };
  });
  const done = Math.round((reached - start) / 1000);
  const each = apportioned(finished, done);
  const running = byEnd.filter((step) => step.ended === undefined && !step.finished);
  const total = running.length ? Math.max(Math.round((now - start) / 1000), done) : done;
  for (const [index, { id }] of running.entries()) each.set(id, index === 0 ? total - done : 0);
  return { total, each };
}

const hasText = (message: TimelineMessage) => typeof message.content === "string" && message.content.trim() !== "";

/**
 * A Turn's steps, in order: starting up until its first step began, each thought, each tool call (writing its input,
 * running it), and the answer. A step ends at its replayed stamp, else where its live clock stopped here.
 */
function stepsOf(turn: readonly TimelineMessage[], startId: string, running: boolean): TimedStep[] {
  const lastCall = turn.findLastIndex((message) => message.toolCalls?.length);
  const texts = turn.filter((message, index) => message.role === "assistant" && !message.toolCalls?.length && hasText(message) && index > lastCall);
  const answer = texts.at(-1) ?? turn.findLast((message) => message.role === "assistant" && !message.toolCalls?.length && hasText(message));
  const work = turn.flatMap((message): TimedStep[] => {
    if (message.role === "reasoning") {
      const clock = thoughtClocks.get(message.id);
      return [{ id: message.id, kind: "thought", finished: clock === undefined && message !== turn.at(-1), began: stampsOf(message)?.[0] ?? clock?.started, ended: stampsOf(message)?.[1] ?? clock?.ended }];
    }
    return (message.toolCalls ?? []).map((call) => {
      const result = turn.find((other) => other.role === "tool" && other.toolCallId === call.id);
      const clock = toolClocks.get(call.id);
      return { id: call.id, kind: "tool", finished: clock === undefined && result !== undefined, began: stampsOf(message)?.[0] ?? clock?.started, ended: running && !result ? undefined : (result && stampsOf(result)?.[1]) ?? clock?.ended };
    });
  });
  const answered: TimedStep[] = answer ? [{ id: answer.id, kind: "answer", began: stampsOf(answer)?.[0], ended: stampsOf(answer)?.[1] }] : [];
  const first = [...work, ...answered].find((step) => step.began !== undefined);
  return [{ id: startId, kind: "start", ended: first?.began }, ...work, ...answered];
}

/**
 * The Turn's steps on one timeline from Send: the question's stamp, else live, the Chat Service's start, else the
 * Worklog's own clock, which a Turn sent in this tab keeps once it finishes, until its stamps arrive. Starting up shows only when it rounds to a second; under that it joins the first step. A Turn recorded
 * before its question was stamped starts at its first step. Untimed while a finished step has no end.
 */
export function timelineOf(id: string, turn: readonly TimelineMessage[] | undefined, question: TimelineMessage | undefined, running: boolean, serverStart: string | undefined) {
  if (!turn?.length) return undefined;
  const sent = (question && stampsOf(question)?.[0]) ?? (running && serverStart !== undefined ? Date.parse(serverStart) : turnClocks.get(id)?.started);
  const start = sent ?? startOf(turn);
  if (start === undefined) return undefined;
  const startId = `${id}-started-up`;
  const steps = stepsOf(turn, startId, running).map((step) => (step.kind === "answer" && step.ended === undefined && !running ? { ...step, ended: turnClocks.get(id)?.ended } : step));
  if (!running && steps.some((step) => step.ended === undefined)) return undefined;
  const now = Date.now();
  const shown = sent !== undefined && stepSeconds(start, steps, now).each.get(startId) ? steps : steps.filter((step) => step.id !== startId);
  const timed = stepSeconds(start, shown, now);
  // Live, the head keeps counting through a wait whose step hasn't appeared yet; its rows catch up when it does.
  const total = running ? Math.max(timed.total, Math.round((now - start) / 1000)) : timed.total;
  return { total, each: timed.each, steps: shown };
}

/** The Worklog's step of `kind`, with its spoken time, if its timeline has one. */
export function stepOf(timeline: ReturnType<typeof timelineOf>, kind: TimedStep["kind"]): { id: string; time: string } | undefined {
  const step = timeline?.steps.find((candidate) => candidate.kind === kind);
  return step && { id: step.id, time: seconds(timeline?.each.get(step.id) ?? 0) };
}

/** The Worklog's time: its steps' sum, else its own clock or its messages' span, else none. */
export function totalOf(timeline: ReturnType<typeof timelineOf>, time: number | undefined): string | undefined {
  if (timeline) return seconds(timeline.total);
  return time === undefined ? undefined : seconds(Math.round(time / 1000));
}
