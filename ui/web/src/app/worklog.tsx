"use client";


import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion, Collapse } from "./collapse";

import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
  AlignLeftIcon, BotIcon, BrainIcon, CalendarClockIcon, ChevronRightIcon, CircleXIcon, FilePenLineIcon, FileTextIcon, FolderSearchIcon,
  GlobeIcon, ListChecksIcon, SearchIcon, SquareTerminalIcon, TimerIcon, WrenchIcon, type LucideIcon,
} from "lucide-react";

import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";
import { CLOCKS_KEPT, spanOf, startOf, thoughtClocks, turnClocks, useClock, useToolClock } from "./worklog-clock";
import { seconds, stepOf, timelineOf, totalOf } from "./worklog-timeline";

// A step's sheet loads after first load (web-cold-open-check.mjs), once the page is idle, so a tap need not wait
// for it and the Worklog's opening does not stall on it.
const loadStepSheet = () => import("./step-sheet");
const StepSheet = lazy(() => loadStepSheet().then(({ StepSheet }) => ({ default: StepSheet })));
let stepSheetScheduled = false;
function preloadStepSheet(): void {
  if (stepSheetScheduled) return;
  stepSheetScheduled = true;
  const load = () => void loadStepSheet();
  if (typeof requestIdleCallback === "function") requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 1000);
}

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

export const TurnStart = createContext<string | undefined>(undefined);
// The steps seen arriving live, so a row CopilotKit remounts mid-run doesn't grow in again; the newest CLOCKS_KEPT.
const arrived = new Set<string>();

/** Remembers live step `id` as arrived, dropping the oldest past CLOCKS_KEPT. */
function arrive(id: string) {
  arrived.add(id);
  const [oldest] = arrived;
  if (arrived.size > CLOCKS_KEPT && oldest !== undefined) arrived.delete(oldest);
}

/** The call whose card waits on the user: it shows beside the answer, never folded away. */
const PROPOSAL = "propose_scheduled_task";
const SHOWN_CALLS = new Set([PROPOSAL, "Artifact"]);

/** deepagents' execute tool reports a non-zero exit only as this trailer on an otherwise successful result. */
const FAILED_COMMAND = /\n\[Command failed with exit code (\d+)\](\n\[Output was truncated due to size limits\])?$/;

const text = (message: TurnMessage) => (typeof message.content === "string" ? message.content.trim() : "");


type Part = "question" | "work" | "shown";

/**
 * Each message's part in its Turn. The answers are the Turn's texts after its last tool call, each its own bubble; a
 * text before a call is a note, unless no text follows the last call: then the Turn's last text that calls no tool is
 * its answer. While the last Turn runs they show only while its latest message is one: a note reads as an answer until
 * its tool call arrives. A proposed schedule and its result show too. A scheduled run's card, which the Chat Service
 * posts to the Main Chat with no question before it, is no Turn's work: it ends the Turn before it and shows on its own.
 */
function partsOf(messages: readonly TurnMessage[], isRunning: boolean): Map<string, Part> {
  const parts = new Map<string, Part>();
  let turn: TurnMessage[] = [];
  const close = (last: boolean) => {
    const texts = turn.filter((m) => m.role === "assistant" && text(m) !== "" && !m.toolCalls?.length);
    const afterCalls = turn.slice(turn.findLastIndex((m) => m.toolCalls?.length) + 1).filter((m) => texts.includes(m));
    const answers = afterCalls.length > 0 ? afterCalls : texts.slice(-1);
    const answered = !(last && isRunning) || answers.at(-1) === turn.at(-1);
    const shownCalls = new Set(turn.flatMap((m) => (m.toolCalls ?? []).filter((c) => SHOWN_CALLS.has(c.function.name)).map((c) => c.id)));
    for (const m of turn) {
      const makesShownCall = m.toolCalls?.some(({ id }) => shownCalls.has(id)) ?? false;
      const shown = (answered && answers.includes(m)) || makesShownCall || shownCalls.has(m.toolCallId ?? "");
      parts.set(m.id, shown ? "shown" : "work");
    }
    turn = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      close(false);
      parts.set(message.id, "question");
    } else if (message.metadata?.scheduledRun !== undefined) {
      close(false);
      parts.set(message.id, "shown");
    } else turn.push(message);
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
  const latest = messages.at(-1);
  const answering = latest?.role === "assistant" && parts.get(latest.id) === "shown" && !latest.toolCalls?.length && latest.metadata?.scheduledRun === undefined;
  const out: ReactElement[] = [];
  let work: ReactElement[] = [];
  const fold = () => {
    const [row] = work;
    if (row === undefined) return;
    const id = String(row.key);
    const first = messages.findIndex((m) => m.id === messageIdOf(row));
    const next = messages.findIndex((m, i) => i > first && m.role === "user");
    const turn = messages.slice(first, next < 0 ? undefined : next);
    const question = messages.findLast((m, i) => i < first && m.role === "user");
    out.push(
      <Worklog key={id} id={id} turn={turn} question={question} took={spanOf(turn)} startedAt={startOf(turn)} running={isRunning && first > lastQuestion} expanding={isRunning && first > lastQuestion && !answering} asked={asked}>
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

/** Each step's whole seconds in the Worklog around it, by the step's id; none where its Turn has no timeline. */
const StepTimes = createContext<ReadonlyMap<string, number> | null>(null);

/**
 * Open while its Turn works, folded while its answer streams or once it ends. A tap overrides the current phase
 * until work resumes, an answer starts, the run ends or the user asks again (`asked`, their latest message's id).
 * Live, it times the Turn itself, carrying on the clock of the head its Turn showed under `asked` before any row, else from its first replayed step (`startedAt`), as after a reload mid-Turn; replayed, its messages' stamps (`took`). With no rows it has nothing to open.
 */
export function Worklog({ id, turn, question, took, startedAt, running, expanding = running, asked, children }: {
  id: string;
  turn?: readonly TurnMessage[] | undefined;
  question?: TurnMessage | undefined;
  took?: number | undefined;
  startedAt?: number | undefined;
  running: boolean;
  expanding?: boolean | undefined;
  asked: string | undefined;
  children?: ReactNode;
}) {
  const phase = running ? expanding ? "working" : "answering" : "finished";
  const [chosen, setChosen] = useState<{ open: boolean; phase: typeof phase; asked: string | undefined } | null>(null);
  const current = chosen?.phase === phase && chosen.asked === asked;
  if (chosen && !current) setChosen(null);
  const open = current ? chosen.open : phase === "working";
  const serverStart = useContext(TurnStart);
  const time = useClock(turnClocks, id, running, running ? asked : undefined, serverStart === undefined ? startedAt : Date.parse(serverStart)) ?? took;
  const timeline = timelineOf(id, turn, question, running, serverStart);
  const total = totalOf(timeline, time);
  const title = (
    <span className="worklog-title" data-live={running || undefined}>
      {running ? `Working · ${total ?? seconds(0)}` : total === undefined ? "Worked" : `Worked for ${total}`}
    </span>
  );
  const start = stepOf(timeline, "start");
  const answer = stepOf(timeline, "answer");
  if (children === undefined) return <div className="worklog"><div className="worklog-head">{title}</div></div>;
  return (
    <div className="worklog" data-open={open || undefined}>
      <button type="button" className="worklog-head" aria-expanded={open} onClick={() => setChosen({ open: !open, phase, asked })}>
        {title}
        <ChevronRightIcon className="worklog-chevron" aria-hidden />
      </button>
      <Collapse open={open}>
        <div className="worklog-body">
          <StepTimes.Provider value={timeline?.each ?? null}>
            <Presence>{start && (
              <motionElement.div {...presenceMotion} key="start">
                <Step kind="start" state="done" icon={TimerIcon} label={<span className="worklog-step-verb">Started up</span>} time={start.time} />
              </motionElement.div>
            )}</Presence>
            {children}
            <Presence>{answer && (
              <motionElement.div {...presenceMotion} key="answer">
                <Step kind="answer" state={running ? "live" : "done"} icon={AlignLeftIcon} label={<span className="worklog-step-verb">{running ? "Answering" : "Answered"}</span>} time={answer.time} />
              </motionElement.div>
            )}</Presence>
          </StepTimes.Provider>
        </div>
      </Collapse>
    </div>
  );
}

/**
 * One step of a Turn's work: an icon, then one line that truncates, with a chevron after it when it opens to a `sheet`
 * over the chat, and its time in the right-hand column. Live, its words shimmer, and the Worklog's head stands still.
 * Arriving live (`id` first seen), it grows in.
 */
function Step({ id, kind, state, icon: Icon, label, time, sheet }: {
  id?: string | undefined;
  kind: "start" | "thought" | "tool" | "answer";
  state: "live" | "done" | "failed" | "stopped";
  icon: LucideIcon;
  label: ReactNode;
  time?: string | undefined;
  sheet?: { open: boolean; show: () => void } | undefined;
}) {
  const live = state === "live";
  const [grows] = useState(() => live && id !== undefined && !arrived.has(id));
  useEffect(() => {
    if (live && id !== undefined) arrive(id);
  }, [id, live]);
  const Shown = state === "failed" ? CircleXIcon : Icon;
  const icon = <Shown className="worklog-step-icon" strokeWidth={1.75} aria-hidden />;
  const words = <span className="worklog-step-label">{label}</span>;
  const column = <span className="worklog-step-time">{time}</span>;
  const step = (
    <div className="worklog-step" data-kind={kind} data-state={state}>
      <Presence>{sheet ? (
        <motionElement.button {...presenceMotion} key="0" type="button" className="worklog-step-head" onClick={sheet.show} aria-haspopup="dialog" aria-expanded={sheet.open}>
          {icon}{words}<ChevronRightIcon className="worklog-step-chevron" aria-hidden />{column}
        </motionElement.button>
      ) : (
        <motionElement.div {...presenceMotion} key="1" className="worklog-step-head">{icon}{words}{column}</motionElement.div>
      )}</Presence>
    </div>
  );
  return grows ? <Collapse open>{step}</Collapse> : step;
}

/**
 * How each tool the harness offers reads: its name in its sheet's title, its verb done and running ("Ran", not
 * `execute`), its icon, and whether its argument is words rather than code, which reads in sans. Any other tool reads
 * by its name.
 */
const TOOLS: Record<string, { title: string; done: string; running: string; icon: LucideIcon; prose?: true }> = {
  execute: { title: "Terminal", done: "Ran", running: "Running", icon: SquareTerminalIcon },
  read_file: { title: "Read file", done: "Read", running: "Reading", icon: FileTextIcon },
  write_file: { title: "Write file", done: "Wrote", running: "Writing", icon: FilePenLineIcon },
  edit_file: { title: "Edit file", done: "Edited", running: "Editing", icon: FilePenLineIcon },
  ls: { title: "List files", done: "Listed", running: "Listing", icon: FolderSearchIcon },
  glob: { title: "Find files", done: "Found files", running: "Finding files", icon: FolderSearchIcon },
  grep: { title: "Search files", done: "Searched files", running: "Searching files", icon: SearchIcon },
  web_search: { title: "Web search", done: "Searched the web", running: "Searching the web", icon: GlobeIcon, prose: true },
  task: { title: "Helper", done: "Asked a helper", running: "Asking a helper", icon: BotIcon, prose: true },
  write_todos: { title: "Plan", done: "Updated plan", running: "Updating plan", icon: ListChecksIcon, prose: true },
  [PROPOSAL]: { title: "Schedule", done: "Proposed a schedule", running: "Proposing a schedule", icon: CalendarClockIcon, prose: true },
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

/** The whole seconds of step `id` in its Worklog's timeline, spoken; outside one, none. */
function useStepTime(id: string | undefined): string | undefined {
  const time = useContext(StepTimes)?.get(id ?? "");
  return time === undefined ? undefined : seconds(time);
}

/**
 * A tool call: its verb and its argument exactly as run, then its time, opening to a sheet of its full arguments, exit
 * code and output.
 */
export function ToolStep({ id, name, params, status: reported, output: result }: {
  id?: string | undefined;
  name: string;
  params: Record<string, unknown> | undefined;
  status: "running" | "stopped" | "complete";
  output: string | undefined;
}) {
  const cut = reported === "complete" && result !== undefined && UNANSWERED_CALL.test(result);
  const status = cut ? "stopped" : reported;
  const output = cut ? undefined : result;
  useToolClock(id, status === "running");
  const time = useStepTime(id);
  const [open, setOpen] = useState(false);
  // A step's sheet mounts as it first opens, and stays to animate closed: a closed sheet for every step of a long
  // history would each hold a drawer's observers.
  const [opened, setOpened] = useState(false);
  const argument = argumentOf(name, params);
  useEffect(preloadStepSheet, []);
  const said = name.replace(/_/g, " ");
  const look: (typeof TOOLS)[string] = TOOLS[name] ?? { title: said.charAt(0).toUpperCase() + said.slice(1), done: said, running: said, icon: WrenchIcon };
  const { title, done, running, icon, prose } = look;
  const exit = status === "complete" ? FAILED_COMMAND.exec(output ?? "")?.[1] : undefined;
  // The exit code moves to a badge; a truncation note stays with the output.
  const shown = output?.replace(FAILED_COMMAND, (_trailer, _code, truncated: string | undefined) => truncated ?? "").trim();
  const label = (
    <>
      {status === "stopped" && "Stopped · "}
      <span className="worklog-step-verb">{status === "running" ? running : done}</span>
      <Presence>{argument && (
        <motionElement.span {...presenceMotion} className="worklog-step-object" data-prose={prose}>
          {argument}
        </motionElement.span>
      )}</Presence>
    </>
  );
  const state = exit ? "failed" : status === "running" ? "live" : status === "stopped" ? "stopped" : "done";
  if (!argument && !shown) return <Step id={id} kind="tool" state={state} icon={icon} label={label} time={time} />;
  return (
    <>
      <Step id={id} kind="tool" state={state} icon={icon} label={label} time={time} sheet={{ open, show: () => { setOpened(true); setOpen(true); } }} />
      <Suspense fallback={null}>{opened && <StepSheet open={open} onClose={() => setOpen(false)} title={time ? `${title} · ${time}` : title} name={name} params={params} output={shown} exit={exit} prose={prose} />}</Suspense>
    </>
  );
}

/**
 * A thought: "Thought · Planning the rates pull", then its time, opening to a sheet of its reasoning as the provider
 * returned it. With no words it doesn't open; with no time either, and finished, it is nothing.
 */
export function ThoughtStep({ message, isRunning, isLatest }: { message: TurnMessage; isRunning?: boolean; isLatest?: boolean }) {
  const live = Boolean(isRunning && isLatest);
  useClock(thoughtClocks, message.id, live);
  const time = useStepTime(message.id);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const words = text(message);
  if (!live && !words && time === undefined) return null;
  const title = /^\*\*(.+?)\*\*/.exec(words)?.[1];
  const label = (
    <>
      <span className="worklog-step-verb">{live ? "Thinking" : "Thought"}</span>
      <Presence>{title && <motionElement.span {...presenceMotion} className="worklog-step-title">{title}</motionElement.span>}</Presence>
    </>
  );
  const sheet = words ? { open, show: () => { preloadStepSheet(); setOpened(true); setOpen(true); } } : undefined;
  return (
    <>
      <Step id={message.id} kind="thought" state={live ? "live" : "done"} icon={BrainIcon} label={label} time={time} sheet={sheet} />
      <Suspense fallback={null}>{opened && <StepSheet open={open} onClose={() => setOpen(false)} title={time ? `Thought · ${time}` : "Thought"} summary={words} />}</Suspense>
    </>
  );
}
