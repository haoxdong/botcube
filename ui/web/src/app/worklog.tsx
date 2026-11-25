"use client";

import { Fades, Shows } from "./motion";
import { useRenderToolCall } from "@copilotkit/react-core/v2/headless";
import { partialJSONParse } from "@copilotkit/shared";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { argumentOf, ICONS, lookOf, type StepIcon } from "./worklog-tools";

import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";
import { partsOf, PROPOSAL, type Part, type TurnMessage } from "./turn-parts";
import { AnswerCards, AnswerTurn, type Published } from "./artifact-published";
import { CLOCKS_KEPT } from "./worklog-clock";
import { seconds, useTurnTime, type ClockedStep, type TurnTime } from "./turn-clock";
import { idlePreload } from "./preload";

// A step's sheet loads after first load (web-cold-open-check.mjs), once the page is idle, so a tap need not wait
// for it and the Worklog's opening does not stall on it.
const loadStepSheet = () => import("./step-sheet");
const StepSheet = lazy(() => loadStepSheet().then(({ StepSheet }) => ({ default: StepSheet })));
const preloadStepSheet = idlePreload(loadStepSheet);


// The steps seen arriving live, so a row CopilotKit remounts mid-run doesn't fade in again; the newest CLOCKS_KEPT.
const arrived = new Set<string>();

/** Remembers live step `id` as arrived, dropping the oldest past CLOCKS_KEPT. */
function arrive(id: string) {
  arrived.add(id);
  const [oldest] = arrived;
  if (arrived.size > CLOCKS_KEPT && oldest !== undefined) arrived.delete(oldest);
}

type WorklogRendering = "interactive" | "saved";

const SHOWN_CALLS = new Set([PROPOSAL, "Artifact"]);
const CardOnly = createContext(false);

/** deepagents' execute tool reports a non-zero exit only as this trailer on an otherwise successful result. */
const FAILED_COMMAND = /\n\[Command failed with exit code (\d+)\](\n\[Output was truncated due to size limits\])?$/;

const text = (message: TurnMessage) => (typeof message.content === "string" ? message.content.trim() : "");

/**
 * The message a row lays out. CopilotKit passes each of its rows, custom-message slots included, its message, and keys
 * it by an id the message may since have lost to a merged stream's rename; other lists key a row by its message's id.
 */
function messageIdOf(row: ReactElement): string {
  const { props } = row;
  const message = typeof props === "object" && props !== null && "message" in props ? props.message : undefined;
  return typeof message === "object" && message !== null && "id" in message && typeof message.id === "string" ? message.id : String(row.key);
}

export const worklogKey = (turn: string) => `worklog:${turn}`;

/**
 * The chat's rows with each Turn's work rows folded into its Worklog, keyed by its Turn: a remount empties the row for a
 * layout, and WebKit clamps the scroll to that shorter list. A Worklog runs while the run is its Turn's, and its time is
 * its Turn's, answer included.
 */
export function worklogRows(rows: readonly ReactElement[], messages: readonly TurnMessage[], isRunning: boolean, { started = isRunning, rendering = "interactive" }: { started?: boolean; rendering?: WorklogRendering } = {}): ReactElement[] {
  const advanceClock = rendering === "interactive";
  const { parts, cards } = partsOf(messages, isRunning);
  const lastQuestion = messages.findLastIndex(({ role }) => role === "user");
  const asked = messages[lastQuestion]?.id;
  const latest = messages.at(-1);
  const out: ReactElement[] = [];
  let work: ReactElement[] = [];
  let shown: ReactElement[] = [];
  let firstMessage: string | undefined;
  let turnKey = messages[0]?.id ?? "";
  const steps: Steps = { turn: messages, lastQuestion, isRunning, rendering, summarized: new Set<string>() };
  const fold = () => {
    const [row] = work;
    if (row !== undefined) {
      const id = String(row.key);
      const first = messages.findIndex((m) => m.id === firstMessage);
      const next = messages.findIndex((m, i) => i > first && (m.role === "user" || m.metadata?.scheduledRun !== undefined));
      const turn = messages.slice(first, next < 0 ? undefined : next);
      const question = messages.findLast((m, i) => i < first && m.role === "user");
      out.push(
        <Worklog key={worklogKey(turnKey)} id={id} advanceClock={advanceClock} turn={turn} question={question} running={isRunning && started && first > lastQuestion} asked={asked}>
          {work}
        </Worklog>,
      );
    }
    out.push(...shown);
    work = [];
    shown = [];
    firstMessage = undefined;
  };
  for (const row of rows) {
    const messageId = messageIdOf(row);
    const message = messages.find((candidate) => candidate.id === messageId);
    if (message?.role === "user" || message?.metadata?.scheduledRun !== undefined) {
      fold();
      turnKey = message.id;
      out.push(row);
    } else if (parts.get(messageId) === "work") {
      firstMessage ??= messageId;
      work.push(...workRow(row, message, steps));
    } else {
      const summary = stepsOf(row, message, SHOWN_CALLS, steps);
      if (summary.length > 0) firstMessage ??= messageId;
      work.push(...summary);
      shown.push(...shownRow(row, message, parts.get(messageId), cards.get(messageId), { id: turnKey, stage: turnKey === asked ? latest?.id ?? turnKey : turnKey }));
    }
  }
  fold();
  if (isRunning && started && latest?.role === "user") {
    out.push(<Worklog key={worklogKey(latest.id)} id={latest.id} advanceClock={advanceClock} running asked={latest.id} />);
  }
  return out;
}

type Steps = { turn: readonly TurnMessage[]; lastQuestion: number; isRunning: boolean; rendering: WorklogRendering; summarized: Set<string> };

function stepsOf(row: ReactElement, message: TurnMessage | undefined, names: ReadonlySet<string>, { turn, lastQuestion, isRunning, rendering, summarized }: Steps): ReactElement[] {
  if (!message?.toolCalls?.some((call) => rendering === "saved" || names.has(call.function.name)) || summarized.has(message.id)) return [];
  summarized.add(message.id);
  return [<CallSteps key={rendering === "saved" ? `${String(row.key)}-calls` : row.key} message={message} turn={turn} rendering={rendering} running={isRunning && turn.indexOf(message) > lastQuestion} />];
}

const ARTIFACT_CALL = new Set(["Artifact"]);

function workRow(row: ReactElement, message: TurnMessage | undefined, steps: Steps): ReactElement[] {
  if (message?.role === "assistant" && !message.toolCalls?.length && text(message) !== "") return [<NoteStep key={row.key} id={message.id}>{row}</NoteStep>];
  if (steps.rendering === "saved") return [row, ...stepsOf(row, message, SHOWN_CALLS, steps)];
  return message?.toolCalls?.some((call) => call.function.name === "Artifact") ? stepsOf(row, message, ARTIFACT_CALL, steps) : [row];
}

/** Text a tool call followed, timed in the steps' column. */
function NoteStep({ id, children }: { id: string; children: ReactNode }) {
  return <div className="worklog-step worklog-note" data-step-id={id} data-kind="note" data-state="done"><div className="worklog-step-label worklog-note-text">{children}</div><span className="worklog-step-time">{useStepTime(id)}</span></div>;
}

/** A shown row: a card shows without its ToolStep, and an answer shows the cards of the Artifacts its Turn published; a card the answer shows has no row. */
function shownRow(row: ReactElement, message: TurnMessage | undefined, part: Part | undefined, answerCards: readonly Published[] | undefined, turn: { id: string; stage: string }): ReactElement[] {
  if (part === "card") return [];
  const card = <CardOnly.Provider key={row.key} value={Boolean(message?.toolCalls?.some((call) => SHOWN_CALLS.has(call.function.name)))}>{row}</CardOnly.Provider>;
  return [answerCards === undefined ? card : <AnswerTurn.Provider key={row.key} value={turn}><AnswerCards.Provider value={answerCards}>{card}</AnswerCards.Provider></AnswerTurn.Provider>];
}

function CallSteps({ message, turn, running, rendering }: { message: TurnMessage; turn: readonly TurnMessage[]; running: boolean; rendering: WorklogRendering }) {
  return <>{message.toolCalls?.map((call) => {
    const result = turn.find((candidate) => candidate.toolCallId === call.id);
    if (rendering === "interactive" && !SHOWN_CALLS.has(call.function.name)) return <RenderedCall key={call.id} call={call} result={result} />;
    return <ToolStep key={call.id} id={call.id} name={call.function.name} params={rendering === "saved" ? partialJSONParse(call.function.arguments ?? "") : undefined} status={result ? "complete" : running ? "running" : "stopped"} output={typeof result?.content === "string" ? result.content : undefined} />;
  })}</>;
}

function RenderedCall({ call, result }: { call: NonNullable<TurnMessage["toolCalls"]>[number]; result: TurnMessage | undefined }) {
  const render = useRenderToolCall();
  if (result && typeof result.content !== "string") throw new Error("A tool result must contain text");
  return render({
    toolCall: { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments ?? "" } },
    ...(result && typeof result.content === "string" ? { toolMessage: { id: result.id, role: "tool", toolCallId: call.id, content: result.content } } : {}),
  });
}

/** A line under way shimmers; Trace's `status` is optional without `undefined`, so a line at rest leaves it out. */
const lineStatus = (running: boolean) => (running ? { status: "running" as const } : {});

/** Each step's whole seconds in the Worklog around it, by the step's id; none where its Turn has no timeline. */
const StepTimes = createContext<{ each: ReadonlyMap<string, number> | undefined; arriving: boolean }>({ each: undefined, arriving: true });

function stepOf(time: TurnTime, kind: ClockedStep["kind"]): { id: string; time: string } | undefined {
  const step = time.steps.find((candidate) => candidate.kind === kind);
  return step && { id: step.id, time: seconds(step.seconds) };
}

/**
 * Open while its Turn runs, so text written mid-Turn never folds it, and folded once it ends. A tap holds until the
 * run ends or the user asks again (`asked`, their latest message's id).
 * Its times are its Turn's clock's (`useTurnTime`). With no rows it has nothing to open.
 */
export function Worklog({ id, turn, question, running, asked, children, advanceClock = true }: {
  id: string;
  turn?: readonly TurnMessage[] | undefined;
  question?: TurnMessage | undefined;
  running: boolean;
  advanceClock?: boolean | undefined;
  asked: string | undefined;
  children?: ReactNode;
}) {
  const phase = running ? "working" : "finished";
  const [chosen, setChosen] = useState<{ open: boolean; phase: typeof phase; asked: string | undefined } | null>(null);
  const current = chosen?.phase === phase && chosen.asked === asked;
  if (chosen && !current) setChosen(null);
  const open = current ? chosen.open : phase === "working";
  const time = useTurnTime(question?.id ?? id, { turn, question, running, viewId: id, advanceClock });
  const each = new Map(time.steps.map((step) => [step.id, step.seconds]));
  const total = time.total === undefined ? undefined : seconds(time.total);
  const title = (
    <TraceLine {...lineStatus(!time.settled)}>
      <TraceTitle className="worklog-title" data-live={!time.settled || undefined}>
        {!time.settled ? `Working · ${total ?? seconds(0)}` : total === undefined ? "Worked" : `Worked for ${total}`}
      </TraceTitle>
    </TraceLine>
  );
  const start = stepOf(time, "start");
  const answer = stepOf(time, "answer");
  const diagnosticView = time.steps.find(step => step.kind !== "start")?.id ?? id;
  if (children === undefined) return <div className="worklog" data-worklog-turn={question?.id ?? asked ?? id}><div className="worklog-head">{title}</div></div>;
  return (
    <TraceCollapsible className="worklog" data-worklog-turn={question?.id ?? asked ?? id} data-open={open || undefined} data-chosen={current || undefined} data-still={!advanceClock || undefined} open={open} onOpenChange={(next) => setChosen({ open: next, phase, asked })}>
      <TraceCollapsibleTrigger className="worklog-head">{title}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="worklog-body">
        <StepTimes.Provider value={{ each, arriving: advanceClock }}>
          <Fades>{start && (
            <div key="start">
              <Step diagnosticId={`${start.id}:${diagnosticView}`} kind="start" state="done" icon="start" label={<span className="worklog-step-verb">Started up</span>} time={start.time} />
            </div>
          )}</Fades>
          {children}
          <Fades>{answer && (
            <div key="answer">
              <Step diagnosticId={`${answer.id}:${diagnosticView}`} kind="answer" state={running ? "live" : "done"} icon="answer" label={<span className="worklog-step-verb">{running ? "Answering" : "Answered"}</span>} time={answer.time} />
            </div>
          )}</Fades>
        </StepTimes.Provider>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * One step of a Turn's work: an icon, then one line that truncates, and its time in the right-hand column. A step that
 * opens to a `sheet` over the chat is a button. Live, its words shimmer, and the Worklog's head stands still.
 * Arriving live (`id` first seen), it fades in.
 */
function Step({ id, diagnosticId = id, kind, state, icon, label, time, sheet }: {
  id?: string | undefined;
  diagnosticId?: string | undefined;
  kind: "start" | "thought" | "tool" | "answer";
  state: "live" | "done" | "failed" | "stopped";
  icon: StepIcon;
  label: ReactNode;
  time?: string | undefined;
  sheet?: { open: boolean; show: () => void } | undefined;
}) {
  const live = state === "live";
  const { arriving } = useContext(StepTimes);
  const [fades] = useState(() => arriving && live && id !== undefined && !arrived.has(id));
  useEffect(() => {
    if (live && id !== undefined) arrive(id);
  }, [id, live]);
  const shown = state === "failed" ? "failed" : icon;
  const Icon = ICONS[shown];
  const line = (
    <TraceLine {...lineStatus(live)}>
      <TraceIcon className="worklog-step-icon">
        <Icon data-icon={shown} />
      </TraceIcon>
      <TraceTitle className="worklog-step-label">{label}</TraceTitle>
      <TraceDescription className="worklog-step-time">{time}</TraceDescription>
    </TraceLine>
  );
  const Head = sheet ? "button" : "div";
  const step = (
    <Trace className="worklog-step" data-step-id={diagnosticId} data-kind={kind} data-state={state}>
      <Head type={sheet ? "button" : undefined} className="worklog-step-head" onClick={sheet?.show} aria-haspopup={sheet ? "dialog" : undefined} aria-expanded={sheet?.open}>
        {line}
      </Head>
    </Trace>
  );
  return fades ? <Shows appear when className="worklog-step-arrival">{step}</Shows> : step;
}

/** The whole seconds of step `id` in its Worklog's timeline, spoken; outside one, none. */
function useStepTime(id: string | undefined): string | undefined {
  const time = useContext(StepTimes).each?.get(id ?? "");
  return time === undefined ? undefined : seconds(time);
}

/**
 * A tool call: its verb and its argument exactly as run, then its time, opening to a sheet of its full arguments, exit
 * code and output.
 */
type ToolStepProps = {
  id?: string | undefined;
  name: string;
  params: Record<string, unknown> | undefined;
  status: "running" | "stopped" | "complete";
  output: string | undefined;
};

export function ToolStep(props: ToolStepProps) {
  const cardOnly = useContext(CardOnly);
  return cardOnly ? null : <TimedToolStep {...props} />;
}

function TimedToolStep({ id, name, params, status: reported, output: result }: ToolStepProps) {
  const cut = reported === "complete" && result !== undefined && UNANSWERED_CALL.test(result);
  const status = cut ? "stopped" : reported;
  const output = cut ? undefined : result;
  const time = useStepTime(id);
  const [open, setOpen] = useState(false);
  // A step's sheet mounts as it first opens, and stays to animate closed: a closed sheet for every step of a long
  // transcript would each hold a drawer's observers.
  const [opened, setOpened] = useState(false);
  const argument = argumentOf(name, params);
  useEffect(() => {
    preloadStepSheet();
  }, []);
  const look = lookOf(name);
  const { title, done, running, icon, prose } = look;
  const exit = status === "complete" ? FAILED_COMMAND.exec(output ?? "")?.[1] : undefined;
  // The exit code moves to a badge; a truncation note stays with the output.
  const shown = output?.replace(FAILED_COMMAND, (_trailer, _code, truncated: string | undefined) => truncated ?? "").trim();
  const label = (
    <>
      {status === "stopped" && "Stopped · "}
      <span className="worklog-step-verb">{status === "running" ? running : done}</span>
      {argument && " "}
      <Fades>{argument && (
        <span className="worklog-step-object">
          {argument}
        </span>
      )}</Fades>
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
  const time = useStepTime(message.id);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const words = text(message);
  if (!live && !words && time === undefined) return null;
  const title = /^\*\*(.+?)\*\*/.exec(words)?.[1];
  const label = (
    <>
      <span className="worklog-step-verb">{live ? "Thinking" : "Thought"}</span>
      {title && " · "}
      <Fades>{title && <span className="worklog-step-title">{title}</span>}</Fades>
    </>
  );
  const sheet = words ? { open, show: () => { preloadStepSheet(); setOpened(true); setOpen(true); } } : undefined;
  return (
    <>
      <Step id={message.id} kind="thought" state={live ? "live" : "done"} icon="thought" label={label} time={time} sheet={sheet} />
      <Suspense fallback={null}>{opened && <StepSheet open={open} onClose={() => setOpen(false)} title={time ? `Thought · ${time}` : "Thought"} summary={words} heading={title} />}</Suspense>
    </>
  );
}
