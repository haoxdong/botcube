"use client";


import { m as motionElement } from "framer-motion";
import { useRenderToolCall } from "@copilotkit/react-core/v2";
import { Presence, presenceMotion, Collapse } from "./collapse";

import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { AlignLeftIcon, BrainIcon, ChevronRightIcon, CircleXIcon, TimerIcon, type LucideIcon } from "lucide-react";
import { argumentOf, lookOf } from "./worklog-tools";

import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";
import { partsOf, PROPOSAL, type Part, type TurnMessage } from "./turn-parts";
import { AnswerCards, type Published } from "./artifact-published";
import { CLOCKS_KEPT, spanOf, startOf, useWorklogClock } from "./worklog-clock";
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


export const TurnStart = createContext<string | undefined>(undefined);
// The steps seen arriving live, so a row CopilotKit remounts mid-run doesn't grow in again; the newest CLOCKS_KEPT.
const arrived = new Set<string>();

/** Remembers live step `id` as arrived, dropping the oldest past CLOCKS_KEPT. */
function arrive(id: string) {
  arrived.add(id);
  const [oldest] = arrived;
  if (arrived.size > CLOCKS_KEPT && oldest !== undefined) arrived.delete(oldest);
}

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

/**
 * The chat's rows with each Turn's work rows folded into its Worklog, keyed as its first row so a row that pages the chat
 * counts it as one and a renamed message keeps its Worklog's clock. A Worklog runs while the run is its Turn's, and its
 * time is its Turn's, answer included.
 */
export function worklogRows(rows: readonly ReactElement[], messages: readonly TurnMessage[], isRunning: boolean, { started = isRunning, cardSteps = true }: { started?: boolean; cardSteps?: boolean } = {}): ReactElement[] {
  const { parts, cards } = partsOf(messages, isRunning);
  const lastQuestion = messages.findLastIndex(({ role }) => role === "user");
  const asked = messages[lastQuestion]?.id;
  const latest = messages.at(-1);
  const answering = latest?.role === "assistant" && parts.get(latest.id) === "shown" && !latest.toolCalls?.length && latest.metadata?.scheduledRun === undefined;
  const out: ReactElement[] = [];
  let work: ReactElement[] = [];
  let shown: ReactElement[] = [];
  let firstMessage: string | undefined;
  const steps: Steps = { turn: messages, lastQuestion, isRunning, cardSteps, summarized: new Set<string>() };
  const fold = () => {
    const [row] = work;
    if (row !== undefined) {
      const id = String(row.key);
      const first = messages.findIndex((m) => m.id === firstMessage);
      const next = messages.findIndex((m, i) => i > first && (m.role === "user" || m.metadata?.scheduledRun !== undefined));
      const turn = messages.slice(first, next < 0 ? undefined : next);
      const question = messages.findLast((m, i) => i < first && m.role === "user");
      out.push(
        <Worklog key={id} id={id} turn={turn} question={question} took={spanOf(turn)} startedAt={startOf(turn)} running={isRunning && first > lastQuestion} expanding={isRunning && first > lastQuestion && !answering} asked={asked}>
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
      out.push(row);
    } else if (parts.get(messageId) === "work") {
      firstMessage ??= messageId;
      work.push(...workRow(row, message, steps));
    } else {
      const summary = stepsOf(row, message, SHOWN_CALLS, steps);
      if (summary.length > 0) firstMessage ??= messageId;
      work.push(...summary);
      shown.push(...shownRow(row, message, parts.get(messageId), cards.get(messageId)));
    }
  }
  fold();
  if (isRunning && started && latest?.role === "user") {
    out.push(<Worklog key={`worklog:${latest.id}`} id={latest.id} running asked={latest.id} />);
  }
  return out;
}

/** What a Turn's card calls need to show as its Worklog's ToolSteps; `summarized` keeps each message's steps once across its rows. */
type Steps = { turn: readonly TurnMessage[]; lastQuestion: number; isRunning: boolean; cardSteps: boolean; summarized: Set<string> };

/** A message's card calls as ToolSteps, once per message; none when it makes none, its steps already show, or the chat shows no steps. */
function stepsOf(row: ReactElement, message: TurnMessage | undefined, names: ReadonlySet<string>, { turn, lastQuestion, isRunning, cardSteps, summarized }: Steps): ReactElement[] {
  if (!cardSteps || !message?.toolCalls?.some((call) => names.has(call.function.name)) || summarized.has(message.id)) return [];
  summarized.add(message.id);
  return [<CardSteps key={row.key} message={message} turn={turn} running={isRunning && turn.indexOf(message) > lastQuestion} />];
}

const ARTIFACT_CALL = new Set(["Artifact"]);

/** A work row: an Artifact call's steps show as the Worklog's ToolSteps, so a refused publish reads as a step, not an error. */
function workRow(row: ReactElement, message: TurnMessage | undefined, steps: Steps): ReactElement[] {
  return steps.cardSteps && message?.toolCalls?.some((call) => call.function.name === "Artifact") ? stepsOf(row, message, ARTIFACT_CALL, steps) : [row];
}

/** A shown row: a card shows without its ToolStep, and an answer shows the cards of the Artifacts its Turn published; a card the answer shows has no row. */
function shownRow(row: ReactElement, message: TurnMessage | undefined, part: Part | undefined, answerCards: readonly Published[] | undefined): ReactElement[] {
  if (part === "card") return [];
  const card = <CardOnly.Provider key={row.key} value={Boolean(message?.toolCalls?.some((call) => SHOWN_CALLS.has(call.function.name)))}>{row}</CardOnly.Provider>;
  return [answerCards === undefined ? card : <AnswerCards.Provider key={row.key} value={answerCards}>{card}</AnswerCards.Provider>];
}

function CardSteps({ message, turn, running }: { message: TurnMessage; turn: readonly TurnMessage[]; running: boolean }) {
  return <>{message.toolCalls?.map((call) => {
    const result = turn.find((candidate) => candidate.toolCallId === call.id);
    if (!SHOWN_CALLS.has(call.function.name)) return <RenderedCall key={call.id} call={call} result={result} />;
    return <ToolStep key={call.id} id={call.id} name={call.function.name} params={undefined} status={result ? "complete" : running ? "running" : "stopped"} output={typeof result?.content === "string" ? result.content : undefined} />;
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
  useWorklogClock(running);
  const timeline = timelineOf(question?.id ?? asked ?? id, turn, question, running, serverStart ?? (startedAt === undefined ? undefined : new Date(startedAt).toISOString()), id);
  const total = totalOf(timeline, took);
  const title = (
    <span className="worklog-title" data-live={running || undefined}>
      {running ? `Working · ${total ?? seconds(0)}` : total === undefined ? "Worked" : `Worked for ${total}`}
    </span>
  );
  const start = stepOf(timeline, "start");
  const answer = stepOf(timeline, "answer");
  const diagnosticView = timeline?.steps.find(step => step.kind !== "start")?.id ?? id;
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
                <Step diagnosticId={`${start.id}:${diagnosticView}`} kind="start" state="done" icon={TimerIcon} label={<span className="worklog-step-verb">Started up</span>} time={start.time} />
              </motionElement.div>
            )}</Presence>
            {children}
            <Presence>{answer && (
              <motionElement.div {...presenceMotion} key="answer">
                <Step diagnosticId={`${answer.id}:${diagnosticView}`} kind="answer" state={running ? "live" : "done"} icon={AlignLeftIcon} label={<span className="worklog-step-verb">{running ? "Answering" : "Answered"}</span>} time={answer.time} />
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
function Step({ id, diagnosticId = id, kind, state, icon: Icon, label, time, sheet }: {
  id?: string | undefined;
  diagnosticId?: string | undefined;
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
  const column = <span className="worklog-step-time" style={{ visibility: time === "0s" ? "hidden" : undefined }}>{time}</span>;
  const Head = sheet ? "button" : "div";
  const step = (
    <div className="worklog-step" data-step-id={diagnosticId} data-kind={kind} data-state={state}>
      <Head type={sheet ? "button" : undefined} className="worklog-step-head" onClick={sheet?.show} aria-haspopup={sheet ? "dialog" : undefined} aria-expanded={sheet?.open}>
        {icon}{words}<ChevronRightIcon className="worklog-step-chevron" style={{ display: sheet ? undefined : "none" }} aria-hidden />{column}
      </Head>
    </div>
  );
  return grows ? <Collapse open>{step}</Collapse> : step;
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
  // history would each hold a drawer's observers.
  const [opened, setOpened] = useState(false);
  const argument = argumentOf(name, params);
  useEffect(preloadStepSheet, []);
  const look = lookOf(name);
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
      <Suspense fallback={null}>{opened && <StepSheet open={open} onClose={() => setOpen(false)} title={time && time !== "0s" ? `${title} · ${time}` : title} name={name} params={params} output={shown} exit={exit} prose={prose} />}</Suspense>
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
      <Presence>{title && <motionElement.span {...presenceMotion} className="worklog-step-title">{title}</motionElement.span>}</Presence>
    </>
  );
  const sheet = words ? { open, show: () => { preloadStepSheet(); setOpened(true); setOpen(true); } } : undefined;
  return (
    <>
      <Step id={message.id} kind="thought" state={live ? "live" : "done"} icon={BrainIcon} label={label} time={time} sheet={sheet} />
      <Suspense fallback={null}>{opened && <StepSheet open={open} onClose={() => setOpen(false)} title={time && time !== "0s" ? `Thought · ${time}` : "Thought"} summary={words} heading={title} />}</Suspense>
    </>
  );
}
