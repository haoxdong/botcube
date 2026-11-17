import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { EventType, type AbstractAgent, type AgentSubscriber, type BaseEvent, type Message } from "@ag-ui/client";
import { z } from "zod";

const stepClockSchema = z.object({ started_at: z.number(), ended_at: z.number().optional() });
const clockSchema = z.object({
  version: z.literal(1), pending: z.boolean().optional(), question_id: z.string().optional(),
  started_at: z.number().optional(), at: z.number().optional(), ended_at: z.number().optional(),
  steps: z.record(z.string(), stepClockSchema).optional(),
});
const frameSchema = clockSchema.extend({ question_id: z.string(), started_at: z.number(), at: z.number(), steps: z.record(z.string(), stepClockSchema) });
export type WorklogClock = z.infer<typeof clockSchema>;
export const WorklogAgent = createContext<AbstractAgent | undefined>(undefined);

const validatedClocks = new WeakMap<object, { clock: WorklogClock; complete: boolean }>();

export function clockOf(value: unknown, complete = false): WorklogClock | undefined {
  if (value === undefined) return undefined;
  const schema = complete ? frameSchema : clockSchema;
  if (value === null || typeof value !== "object") return schema.parse(value);
  const previous = validatedClocks.get(value);
  if (previous && (!complete || previous.complete)) return previous.clock;
  const clock = schema.parse(value);
  validatedClocks.set(value, { clock, complete });
  return clock;
}

export function validateClockEvent(event: BaseEvent): void {
  if (event.type === EventType.RUN_STARTED && event.metadata?.worklog_clock !== undefined) clockOf(event.metadata.worklog_clock, true);
  if (event.type === EventType.STATE_DELTA && "delta" in event) {
    for (const operation of z.array(z.object({ op: z.string(), path: z.string(), value: z.unknown().optional() })).parse(event.delta)) {
      if (operation.path === "/worklog_clock" && operation.op === "add") clockOf(operation.value, true);
    }
  }
}

function withClock(messages: readonly Message[], clock: WorklogClock): Message[] {
  return messages.map(message => message.role === "user" && message.id === clock.question_id
    ? { ...message, metadata: { ...message.metadata, worklog_clock: clock } } : message);
}

export function clockSubscriber(): AgentSubscriber {
  const finish: NonNullable<AgentSubscriber["onRunFinishedEvent"]> = ({ state, messages }) => {
    const clock = clockOf(state.worklog_clock);
    return clock?.at === undefined || clock.pending ? undefined : { messages: withClock(messages, clock) };
  };
  return {
    onRunInitialized: ({ state, messages }) => {
      const question = [...messages].reverse().find(message => message.role === "user");
      return question ? { state: { ...state, worklog_clock: { version: 1, question_id: question.id, pending: true } } } : undefined;
    },
    onRunStartedEvent: ({ event, state, messages }) => {
      const clock = clockOf(event.metadata?.worklog_clock);
      if (clock) return { state: { ...state, worklog_clock: clock }, messages: withClock(messages, { version: 1, question_id: clock.question_id }) };
      const legacy = { ...state };
      delete legacy.worklog_clock;
      return { state: legacy };
    },
    onRunFinishedEvent: finish,
    onRunErrorEvent: ({ state, messages }) => {
      const clock = clockOf(state.worklog_clock);
      return clock?.at === undefined || clock.pending ? undefined : { messages: withClock(messages, clock) };
    },
  };
}

function useServerClock(running: boolean): WorklogClock | undefined {
  const agent = useContext(WorklogAgent);
  const current = useRef<{ agent: AbstractAgent | undefined; value: unknown }>({ agent, value: agent?.state.worklog_clock });
  if (current.current.agent !== agent) current.current = { agent, value: agent?.state.worklog_clock };
  const subscribe = useCallback((notify: () => void) => {
    if (!agent || !running) return () => undefined;
    current.current.value = agent.state.worklog_clock;
    const subscription = agent.subscribe({ onStateChanged: ({ state }) => { current.current.value = state.worklog_clock; notify(); } });
    return () => subscription.unsubscribe();
  }, [agent, running]);
  const snapshot = useCallback(() => running && agent ? current.current.value : undefined, [agent, running]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => clockOf(value), [value]);
}

export function useTurnClock(running: boolean, questionId: string | undefined, recorded: unknown): WorklogClock | undefined {
  const live = useServerClock(running);
  return live?.question_id === questionId ? live : clockOf(recorded);
}

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
