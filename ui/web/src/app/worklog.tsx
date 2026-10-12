"use client";

/**
 * A Turn's work (its thoughts, progress notes and tool calls) as one Worklog above its answer: open while
 * the agent works, folded to "Worked for 38s" once the Turn ends or the user asks again.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
  BotIcon, BrainIcon, CalendarClockIcon, ChevronRightIcon, CircleXIcon, FilePenLineIcon, FileTextIcon, FolderSearchIcon, GlobeIcon,
  ListChecksIcon, SearchIcon, SquareTerminalIcon, WrenchIcon, type LucideIcon,
} from "lucide-react";

import { CodeWords } from "./code-words";

/**
 * A chat message as a Worklog reads it. A replayed agent, reasoning or tool message carries `started_at` and `ended_at`
 * in its metadata, in epoch ms; a user message, and one recorded before the stamps, has none.
 */
export type TurnMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: readonly { id: string; function: { name: string } }[] | undefined;
  toolCallId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/** The call whose card waits on the user: it shows beside the answer, never folded away. */
const PROPOSAL = "propose_scheduled_task";

/** deepagents' execute tool reports a non-zero exit only as this trailer on an otherwise successful result. */
const FAILED_COMMAND = /\n\[Command failed with exit code (\d+)\](\n\[Output was truncated due to size limits\])?$/;

const text = (message: TurnMessage) => (typeof message.content === "string" ? message.content.trim() : "");

/** "42s", "1m 12s". */
const spoken = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

function stampsOf({ metadata }: TurnMessage): [started: number, ended: number] | undefined {
  const { started_at: started, ended_at: ended } = metadata ?? {};
  return typeof started === "number" && typeof ended === "number" ? [started, ended] : undefined;
}

/** How long replayed messages took, from the first one's start to the last one's end; unstamped, nothing. */
function spanOf(messages: readonly TurnMessage[]): number | undefined {
  const stamps = messages.map(stampsOf).filter((span) => span !== undefined);
  return stamps.length ? Math.max(...stamps.map(([, ended]) => ended)) - Math.min(...stamps.map(([started]) => started)) : undefined;
}

type Clock = { started: number; ended?: number };
// The clocks of live Turns and thoughts, by id: they outlive the rows CopilotKit remounts as a chat's messages change.
// Each keeps only its newest clocks, enough for the Turns and thoughts a page shows.
const turnClocks = new Map<string, Clock>();
const thoughtClocks = new Map<string, Clock>();
const CLOCKS_KEPT = 100;

/** Keeps `clock` as `id`'s newest, dropping the oldest past CLOCKS_KEPT. */
function keep(clocks: Map<string, Clock>, id: string, clock: Clock) {
  clocks.delete(id);
  clocks.set(id, clock);
  const [oldest] = clocks.keys();
  if (clocks.size > CLOCKS_KEPT && oldest !== undefined) clocks.delete(oldest);
}

/**
 * How long `id` has run here: from when it first ran until `running` ends, re-rendering each second. A row remounted
 * mid-run carries on from its kept start.
 */
function useClock(clocks: Map<string, Clock>, id: string, running: boolean): number | undefined {
  const [clock, setClock] = useState(() => clocks.get(id));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const live = { started: clocks.get(id)?.started ?? Date.now() };
    keep(clocks, id, live);
    setClock(live);
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(timer);
      const ended = { ...live, ended: Date.now() };
      keep(clocks, id, ended);
      setClock(ended);
    };
  }, [clocks, id, running]);
  return clock && (clock.ended ?? Date.now()) - clock.started;
}

type Part = "question" | "work" | "shown";

/**
 * Each message's part in its Turn. The answer is the Turn's last text that calls no tool, and while the last Turn runs
 * only its latest message can be it: a note reads as the answer until its tool call arrives. A proposed schedule and
 * its result show too.
 */
function partsOf(messages: readonly TurnMessage[], isRunning: boolean): Map<string, Part> {
  const parts = new Map<string, Part>();
  let turn: TurnMessage[] = [];
  const close = (last: boolean) => {
    const answer = turn.findLast((m) => m.role === "assistant" && text(m) !== "" && !m.toolCalls?.length);
    const answered = !(last && isRunning) || answer === turn.at(-1);
    const proposals = new Set(turn.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.function.name === PROPOSAL).map((c) => c.id)));
    for (const m of turn) {
      const proposes = m.toolCalls?.some(({ id }) => proposals.has(id)) ?? false;
      const shown = (answered && m === answer) || proposes || proposals.has(m.toolCallId ?? "");
      parts.set(m.id, shown ? "shown" : "work");
    }
    turn = [];
  };
  for (const message of messages) {
    if (message.role !== "user") turn.push(message);
    else {
      close(false);
      parts.set(message.id, "question");
    }
  }
  close(true);
  return parts;
}

/**
 * The message a row lays out. CopilotKit passes each of its rows, custom-message slots included, its message, and keys
 * it by an id the message may since have lost to a merged stream's rename; other lists key a row by its message's id.
 */
function messageIdOf(row: ReactElement): string {
  const { props } = row;
  const message = typeof props === "object" && props !== null && "message" in props ? props.message : undefined;
  return typeof message === "object" && message !== null && "id" in message && typeof message.id === "string" ? message.id : String(row.key);
}

/**
 * The chat's rows with each Turn's work rows folded into its Worklog, keyed as its first row so a row that pages the chat
 * counts it as one and a renamed message keeps its Worklog's clock. A Worklog runs while the run is its Turn's, and its
 * time is its Turn's, answer included.
 */
export function worklogRows(rows: readonly ReactElement[], messages: readonly TurnMessage[], isRunning: boolean): ReactElement[] {
  const parts = partsOf(messages, isRunning);
  const lastQuestion = messages.findLastIndex(({ role }) => role === "user");
  const asked = messages[lastQuestion]?.id;
  const out: ReactElement[] = [];
  let work: ReactElement[] = [];
  const fold = () => {
    const [row] = work;
    if (row === undefined) return;
    const id = String(row.key);
    const first = messages.findIndex((m) => m.id === messageIdOf(row));
    const next = messages.findIndex((m, i) => i > first && m.role === "user");
    out.push(
      <Worklog key={id} id={id} took={spanOf(messages.slice(first, next < 0 ? undefined : next))} running={isRunning && first > lastQuestion} asked={asked}>
        {work}
      </Worklog>,
    );
    work = [];
  };
  for (const row of rows) {
    if (parts.get(messageIdOf(row)) === "work") work.push(row);
    else {
      fold();
      out.push(row);
    }
  }
  fold();
  return out;
}

/**
 * Open while its Turn runs, folded once it ends. A tap overrides either until the run starts or ends or the user asks
 * again (`asked`, their latest message's id). Live, it times the Turn itself; replayed, its messages' stamps (`took`).
 */
function Worklog({ id, took, running, asked, children }: {
  id: string;
  took: number | undefined;
  running: boolean;
  asked: string | undefined;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<{ open: boolean; running: boolean; asked: string | undefined } | null>(null);
  const open = chosen?.running === running && chosen.asked === asked ? chosen.open : running;
  const time = useClock(turnClocks, id, running) ?? took;
  const title = running ? `Working · ${spoken(time ?? 0)}` : time === undefined ? "Worked" : `Worked for ${spoken(time)}`;
  return (
    <div className="worklog" data-open={open || undefined}>
      <button type="button" className="worklog-head" aria-expanded={open} onClick={() => setChosen({ open: !open, running, asked })}>
        <span className="worklog-title" data-live={running || undefined}>{title}</span>
        <ChevronRightIcon className="worklog-chevron" aria-hidden />
      </button>
      {open && <div className="worklog-body">{children}</div>}
    </div>
  );
}

/**
 * One step of a Turn's work: an icon, then one line that truncates, with a chevron after it when it opens to more.
 * Live, its words shimmer.
 */
function Step({ kind, state, icon: Icon, label, detail }: {
  kind: "thought" | "tool";
  state: "live" | "done" | "failed" | "stopped";
  icon: LucideIcon;
  label: ReactNode;
  detail: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Shown = state === "failed" ? CircleXIcon : Icon;
  const line = (
    <>
      <Shown className="worklog-step-icon" strokeWidth={1.75} aria-hidden />
      <span className="worklog-step-label">{label}</span>
    </>
  );
  return (
    <div className="worklog-step" data-kind={kind} data-state={state} data-open={open || undefined}>
      {detail ? (
        <button type="button" className="worklog-step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          {line}
          <ChevronRightIcon className="worklog-step-chevron" aria-hidden />
        </button>
      ) : (
        <div className="worklog-step-head">{line}</div>
      )}
      {open && detail ? <div className="worklog-step-detail">{detail}</div> : null}
    </div>
  );
}

/**
 * How each tool the harness offers reads: its verb done and running ("Ran", not `execute`), its icon, and whether its
 * argument is words rather than code, which reads in sans. Any other tool reads by its name.
 */
const TOOLS: Record<string, { done: string; running: string; icon: LucideIcon; prose?: true }> = {
  execute: { done: "Ran", running: "Running", icon: SquareTerminalIcon },
  read_file: { done: "Read", running: "Reading", icon: FileTextIcon },
  write_file: { done: "Wrote", running: "Writing", icon: FilePenLineIcon },
  edit_file: { done: "Edited", running: "Editing", icon: FilePenLineIcon },
  ls: { done: "Listed", running: "Listing", icon: FolderSearchIcon },
  glob: { done: "Found files", running: "Finding files", icon: FolderSearchIcon },
  grep: { done: "Searched files", running: "Searching files", icon: SearchIcon },
  web_search: { done: "Searched the web", running: "Searching the web", icon: GlobeIcon, prose: true },
  task: { done: "Asked a helper", running: "Asking a helper", icon: BotIcon, prose: true },
  write_todos: { done: "Updated plan", running: "Updating plan", icon: ListChecksIcon, prose: true },
  [PROPOSAL]: { done: "Proposed a schedule", running: "Proposing a schedule", icon: CalendarClockIcon, prose: true },
};

/** The one argument that says what a call did: the command, the path, the plan's current item, the helper's brief. */
function argumentOf(name: string, params: Record<string, unknown> | undefined): string | undefined {
  if (name === "write_todos" && Array.isArray(params?.todos)) {
    const todos = params.todos as { content?: string; status?: string }[];
    const now = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
    const done = todos.filter((t) => t.status === "completed").length;
    return `${done}/${todos.length} done${now?.content ? ` · ${now.content}` : ""}`;
  }
  for (const key of ["command", "file_path", "path", "description"]) {
    const value = params?.[key];
    if (typeof value === "string") return value;
  }
  return Object.values(params ?? {}).find((value): value is string => typeof value === "string");
}

/**
 * A tool call: its verb and argument, opening to one card of its full argument, exit code and output. `commandPrefix`
 * is the cartridge's binary that every command runs: the label drops it, so the part that differs survives truncation.
 */
export function ToolStep({ name, params, status, output, commandPrefix }: {
  name: string;
  params: Record<string, unknown> | undefined;
  status: "running" | "stopped" | "complete";
  output: string | undefined;
  commandPrefix?: string | undefined;
}) {
  const argument = argumentOf(name, params);
  const said = name.replace(/_/g, " ");
  const look: (typeof TOOLS)[string] = TOOLS[name] ?? { done: said, running: said, icon: WrenchIcon };
  const { done, running, icon, prose } = look;
  const exit = status === "complete" ? FAILED_COMMAND.exec(output ?? "")?.[1] : undefined;
  // The exit code moves to a badge; a truncation note stays with the output.
  const shown = output?.replace(FAILED_COMMAND, (_trailer, _code, truncated: string | undefined) => truncated ?? "").trim();
  const label = (
    <>
      {status === "stopped" && "Stopped · "}
      <span className="worklog-step-verb">{status === "running" ? running : done}</span>
      {argument && (
        <span className="worklog-step-object" data-prose={prose}>
          {name === "execute" && commandPrefix && argument.startsWith(commandPrefix) ? argument.slice(commandPrefix.length) : argument}
        </span>
      )}
    </>
  );
  const detail = (shown || (argument && argument.length > 48)) && (
    <>
      {(argument || exit) && (
        <div className="worklog-step-input" data-prose={prose}>
          <span className="worklog-step-input-text">
            {name === "execute" && argument && <span className="worklog-step-prompt">$ </span>}
            {prose || !argument ? argument : <CodeWords text={argument} />}
          </span>
          {exit && <span className="worklog-step-exit">Exit {exit}</span>}
        </div>
      )}
      {shown && <pre className="worklog-step-output"><CodeWords text={shown} /></pre>}
    </>
  );
  const state = exit ? "failed" : status === "running" ? "live" : status === "stopped" ? "stopped" : "done";
  return <Step kind="tool" state={state} icon={icon} label={label} detail={detail || null} />;
}

/**
 * A thought: "Thought for 4s · Planning the rates pull", opening to the rest of its words. Its time is how long it
 * streamed here, or replayed, its stamps; with neither it is "Thought", and with no words either, nothing.
 */
export function ThoughtStep({ message, isRunning, isLatest }: { message: TurnMessage; isRunning?: boolean; isLatest?: boolean }) {
  const live = Boolean(isRunning && isLatest);
  const time = useClock(thoughtClocks, message.id, live) ?? spanOf([message]);
  const words = text(message);
  if (!live && !words && time === undefined) return null;
  const title = /^\*\*(.+?)\*\*/.exec(words)?.[1];
  const rest = (title ? words.replace(/^\*\*.+?\*\*\s*/, "") : words).trim();
  const label = (
    <>
      <span className="worklog-step-verb">{live ? "Thinking" : time === undefined ? "Thought" : `Thought for ${spoken(time)}`}</span>
      {title && <span className="worklog-step-title">{title}</span>}
    </>
  );
  return <Step kind="thought" state={live ? "live" : "done"} icon={BrainIcon} label={label} detail={rest || null} />;
}
