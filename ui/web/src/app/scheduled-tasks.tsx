"use client";

import { CalendarClock, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { Sheet } from "../components/ui/sheet";
import { StatusPill } from "../components/ui/status-pill";
import { fetchAgentModels, ModelCatalogError, type AgentModel } from "./conversations";
import { throwIfRefused } from "./refusal";
import {
  DAY_NAMES, WEEKDAYS, clock, dayName, dayTime, describeSchedule, fromExpression, lastRun, listing, repeatsWords, runs, stopInstant, summary, toExpression, unitOf, wallTime, wallWords, zoneName,
  type Cadence, type Ending, type Weekday,
} from "./schedule";

/**
 * A scheduled run as the Chat Service posts it to the Main Chat, stored with its message's `metadata`: the task's
 * title, when the run started, how it ended, and its answer or why not. Its request is `messageId` in `sideChat`;
 * a run that never reached its Side Chat, skipped or failed before it, has neither.
 */
export interface ScheduledRun {
  sideChat?: string;
  messageId?: string;
  title: string;
  ranAt: string;
  status: "done" | "failed" | "sign-in" | "skipped";
  text: string;
}

/**
 * How a run ended, in words and tone: one vocabulary for its Main Chat card and its task's Last run. It lives here, not
 * beside the card, since the card brings the Markdown renderer, which would load with the page through the agent sheet.
 */
export const RUN_STATUS: Record<ScheduledRun["status"], { label: string; tone: "neutral" | "blue" | "danger" }> = {
  done: { label: "Done", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  "sign-in": { label: "Needs sign-in", tone: "blue" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** The agent's proposal, including obsolete count fields retained in saved chats. */
export type ScheduledTaskProposal = { title: string; prompt: string; timezone?: string | null; starts?: string | null; ends?: string | null; count?: number | null } & (Cadence | { schedule: string });

/** A task the agent runs on its schedule, as the Chat Service's `/scheduled-tasks` lists it. */
export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  /** The Scheduler expression it runs on. */
  schedule: string;
  timezone: string;
  /** The model its runs use; absent, they use the account's default, the first of its models. */
  model?: string;
  /** Its first run, an ISO instant; absent for a one-off, whose schedule says when, and a schedule the Chat Service can't read. */
  startDate?: string;
  /** The stop time, an ISO instant, after which the task no longer runs. */
  endDate?: string;
  /** How many runs it makes before it leaves the account. */
  maxRuns?: number;
  /** How many of those runs it has made. */
  runsMade?: number;
  paused: boolean;
  /** The tool call ID of the proposal the task was confirmed from. */
  proposalId: string;
  /** When it next runs; absent while paused, and once it has ended. */
  nextRun?: string;
  /** Why its next run is unknown: the Chat Service cannot read its stored schedule. Absent while paused. */
  nextRunUnknown?: string;
  /** Past its stop time, or with no run left before it: it no longer runs, and can't resume until Edit moves the time. */
  ended: boolean;
  /** Whether its Side Chat exists, which a run makes once it reaches it. */
  sideChat: boolean;
  /** How its latest run ended; absent before its first run. */
  lastRun?: { at: string; status: "done" | "failed" | "sign-in" };
}

/** The Chat Service's answer, or an error naming its `detail` (or else its status). */
async function answered<T>(response: Response, failure: string): Promise<T> {
  await throwIfRefused(response, failure);
  return (await response.json()) as T;
}

/** The account's tasks, as the Chat Service's `/scheduled-tasks` lists them. */
async function listTasks(chatServiceUrl: string): Promise<ScheduledTask[]> {
  const response = await fetch(`${chatServiceUrl}/scheduled-tasks`, { credentials: "include", cache: "no-store" });
  return (await answered<{ tasks: ScheduledTask[] }>(response, "Scheduled tasks failed")).tasks;
}

async function sendTask(chatServiceUrl: string, path: string, method: string, body: object, failure: string) {
  const response = await fetch(`${chatServiceUrl}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return answered<ScheduledTask>(response, failure);
}

/** The tasks under their frequency labels, each label where its first task is listed. */
function byFrequency(tasks: ScheduledTask[]): { label: string; tasks: ScheduledTask[] }[] {
  const groups = new Map<string, ScheduledTask[]>();
  for (const task of tasks) {
    const { label } = listing(task.schedule);
    groups.set(label, [...(groups.get(label) ?? []), task]);
  }
  return [...groups].map(([label, grouped]) => ({ label, tasks: grouped }));
}

type Counted = Extract<Ending, { kind: "after" }>;

/** After N runs, with the last of them counted on from the first still to come, where that is known. */
function afterRuns(maxRuns: number, runsMade: number, cadence: Cadence | null, first: number | undefined, timezone: string): Counted {
  const left = maxRuns - runsMade;
  const last = cadence === null || first === undefined || left < 1 ? undefined : lastRun(cadence, first, left, timezone);
  return { kind: "after", runs: maxRuns, last };
}

function countedEnding(task: ScheduledTask, count: number, cadence: Cadence | null, start: number | undefined, timezone: string): Counted {
  let first = start ?? (task.nextRun === undefined ? Date.now() : Date.parse(task.nextRun));
  if (start !== undefined && cadence !== null && "every" in cadence) {
    const period = cadence.every * (cadence.frequency === "minutes" ? 60_000 : 3_600_000);
    first = start + Math.max(0, Math.floor((Date.now() - start) / period) + 1) * period;
  } else if (start !== undefined) first = Math.max(start, Date.now() + 1);
  return afterRuns(count, task.runsMade ?? 0, cadence, first, timezone);
}

/**
 * A proposal's schedule in one line, as its task would run if confirmed now: a rate first runs a period from now. A
 * count of runs reads as the last of them, as the task's sheet says it.
 */
function proposalSummary(schedule: string, timezone: string, endDate: string | undefined, count: number | null | undefined, startDate?: string): string {
  const now = Date.now();
  const cadence = fromExpression(schedule);
  const first = cadence === null || cadence.frequency === "once" ? undefined : runs(cadence, now, 2, timezone)["every" in cadence ? 1 : 0];
  // A field sent as null is unused, as the Harness reads it.
  const counted = count == null ? undefined : afterRuns(count, 0, cadence, first, timezone);
  const stop = endDate === undefined ? undefined : Date.parse(endDate);
  const ending: Ending = stop !== undefined && (counted?.last === undefined || stop < counted.last)
    ? { kind: "on", at: stop } : counted ?? { kind: "never" };
  const words = summary(schedule, timezone, first, ending, now, startDate === undefined ? undefined : Date.parse(startDate));
  return counted !== undefined && counted.last === undefined && stop !== undefined ? `${words}, up to ${counted.runs} ${unitOf("run", counted.runs)}` : words;
}

/**
 * The agent's proposal as a card the user confirms; confirming schedules it in its proposed timezone.
 * The proposal's tool call ID names it, so a card confirmed again answers the task it already made,
 * and a card whose proposal the account's tasks already hold shows it scheduled.
 */
export function ScheduledTaskProposalCard({
  chatServiceUrl,
  proposalId,
  proposal,
  result,
}: {
  chatServiceUrl: string;
  proposalId: string;
  proposal: ScheduledTaskProposal;
  result: unknown;
}) {
  // Busy until the account's tasks say whether this proposal is already confirmed.
  const [state, setState] = useState<"proposed" | "busy" | "scheduled">("busy");
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => {
      listTasks(chatServiceUrl).then(
        (tasks) => setState(tasks.some((task) => task.proposalId === proposalId) ? "scheduled" : "proposed"),
        (failure: Error) => {
          setError(failure.message);
          setState("proposed");
        },
      );
    },
    // Stryker disable next-line ArrayDeclaration: a card's Chat Service URL and proposal never change, so it checks once
    [chatServiceUrl, proposalId],
  );

  const timezone = proposal.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The proposal's expression and stop time, or why its fields make none.
  let schedule: string | null = null;
  let startDate: string | undefined;
  let endDate: string | undefined;
  let unscheduled: string | null = null;
  let model: string | undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    schedule = "schedule" in proposal ? proposal.schedule : toExpression(proposal);
    if (result !== "Proposed. Nothing is scheduled until the user confirms it in the chat.") {
      const provenance: unknown = typeof result === "string" ? JSON.parse(result) : result;
      if (typeof provenance !== "object" || provenance === null || !("model" in provenance) || typeof provenance.model !== "string" || !provenance.model.trim()) {
        throw new Error("The proposing Turn has no model key");
      }
      model = provenance.model;
    }
    // A field sent as null is unused, as the Harness reads it.
    if (proposal.starts != null) startDate = stopInstant(proposal.starts, timezone);
    if (proposal.ends != null) endDate = stopInstant(proposal.ends, timezone);
  } catch (failure) {
    schedule = null;
    unscheduled = `This proposal has no schedule: ${(failure as Error).message}`;
  }

  const confirm = async (schedule: string) => {
    setState("busy");
    setError(null);
    try {
      if (proposal.count != null) throw new Error('This proposal uses a run count. Ask the agent for start and end times.');
      const { title, prompt } = proposal;
      const task = { title, prompt, schedule, timezone, ...(model === undefined ? {} : { model }), ...(startDate === undefined ? {} : { startDate }), ...(endDate === undefined ? {} : { endDate }), proposalId };
      await sendTask(chatServiceUrl, "/scheduled-tasks", "POST", task, "Scheduling failed");
      setState("scheduled");
    } catch (failure) {
      setError((failure as Error).message);
      setState("proposed");
    }
  };

  return (
    <div className="scheduled-proposal">
      <p className="scheduled-task-title">{proposal.title}</p>
      <p className="scheduled-task-prompt">{proposal.prompt}</p>
      {schedule === null ? (
        <p className="agent-profile-error">{unscheduled}</p>
      ) : (
        <>
          <p className="scheduled-task-schedule">{proposalSummary(schedule, timezone, endDate, proposal.count, startDate)}</p>
          {state === "scheduled" ? (
            <p className="scheduled-proposal-done">Scheduled. Manage it in the Scheduled tab.</p>
          ) : passed(schedule, timezone) ? (
            // A one-off task leaves the account once it has run: its card offers no second run.
            <p className="scheduled-proposal-done">Its time has passed.</p>
          ) : (
            <Button variant="primary" className="scheduled-proposal-confirm" disabled={state === "busy"} onClick={() => void confirm(schedule)}>
              Confirm
            </Button>
          )}
        </>
      )}
      {error && <p className="agent-profile-error">{error}</p>}
    </div>
  );
}

/** One term of a task's details and what it reads, as a settings row (DESIGN.md). */
function Detail({ term, title, children }: { term: string; title?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <dt>{term}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

/** Next run: Ended, Paused, Unknown or its day and time; nothing before it has one. */
function nextRun(task: ScheduledTask): ReactNode {
  if (task.ended) return <Detail term="Next run">Ended</Detail>;
  if (task.paused) return <Detail term="Next run">Paused</Detail>;
  // A schedule the Chat Service cannot read runs at a time it can't say: Unknown, with why on hover.
  if (task.nextRunUnknown !== undefined) return <Detail term="Next run" title={task.nextRunUnknown}>Unknown</Detail>;
  return task.nextRun === undefined ? null : <Detail term="Next run">{dayTime(task.nextRun, task.timezone)}</Detail>;
}

/**
 * What a task's sheet says of it, each time in its time zone, laid out as Edit opens on it, read-only: Repeat and the
 * row it needs in a card; then a second card, which Edit has not, of its next run (its first, before it has run) and
 * how its last run ended, where it has either; then More, shut, over Edit's More: Starts and Ends but for a one-off,
 * then the model (spec story 73).
 */
function TaskDetails({ task, models, modelsFailed, runsOn }: {
  task: ScheduledTask;
  models: AgentModel[] | null;
  modelsFailed: boolean;
  runsOn: string | undefined;
}) {
  // The draft Edit opens on, so the sheet and Edit say one thing.
  const model = runsOn ?? "";
  const draft = draftOf(task, model);
  const made = pickedSchedule(draft.repeat, draft.starts, task.timezone);
  const ending = "why" in made ? undefined : endingOf(draft, task, made.cadence, Date.parse(made.start));
  const next = nextRun(task);
  const last = task.lastRun;
  // Shut each time the sheet opens: the sheet's body mounts anew.
  const [more, setMore] = useState(false);
  return (
    <>
      <dl className="settings-group">
        {repeatRows(draft.repeat, draft.starts, task.timezone).map(([term, words]) => (
          <Detail key={term} term={term}>
            {words}
          </Detail>
        ))}
      </dl>
      {(next || last) && (
        <dl className="settings-group">
          {next}
          {last && (
            <Detail term="Last run">
              {/* The pill leads, so the time ends flush right under Next run's. */}
              <StatusPill tone={RUN_STATUS[last.status].tone}>{RUN_STATUS[last.status].label}</StatusPill>
              {dayTime(last.at, task.timezone)}
            </Detail>
          )}
        </dl>
      )}
      <More open={more} onToggle={() => setMore(!more)}>
        <dl className="settings-group">
          {draft.repeat.frequency !== "once" && (
            <>
              <Detail term="Starts">{whenWords(draft.starts, task.timezone, false)}</Detail>
              {/* A stop time in the past reads as its time: Next run alone says Ended (issues #3860, #3861). */}
              <Detail term="Ends">{endsWords(draft.ends, countedWall(ending, task.timezone), task.timezone)}</Detail>
            </>
          )}
          {/* Edit's select names the model while the catalog loads; the sheet says only that it loads. */}
          <Detail term="Model">
            {models === null && !modelsFailed ? "Loading…" : modelChoices(task, models, modelsFailed, runsOn).find(({ value }) => value === model)?.label}
          </Detail>
        </dl>
      </More>
    </>
  );
}

/**
 * More, as Codex's, under a card in Edit and in a task's sheet alike: muted words over a chevron that turns up while
 * open, and under it, while open, what it folds away.
 */
function More({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <button type="button" className="settings-more" aria-expanded={open} onClick={onToggle}>
        More
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && children}
    </>
  );
}

/** Whether a one-off schedule's time, in its time zone, has passed. */
function passed(schedule: string, timezone: string): boolean {
  const cadence = fromExpression(schedule);
  return cadence?.frequency === "once" && Date.parse(stopInstant(`${cadence.date}T${cadence.time}`, timezone)) <= Date.now();
}

/** Ended once it has, else Paused while paused; nothing for a task that runs. */
function TaskStatus({ task }: { task: ScheduledTask }) {
  if (task.ended) return <StatusPill>Ended</StatusPill>;
  return task.paused ? <StatusPill>Paused</StatusPill> : null;
}

/** The day of the week a date and time (YYYY-MM-DDTHH:MM) falls on; none while it isn't one. */
function weekdayOf(wall: string): Weekday | undefined {
  return WEEKDAYS[new Date(`${wall.slice(0, 10)}T00:00:00Z`).getUTCDay()];
}

/**
 * Repeat's choices, after Codex's Schedule a task: every N minutes (Interval), daily, on weekdays or weekly at a time,
 * once, or the task's own schedule where none of these says it (Custom).
 */
type Frequency = "interval" | "daily" | "weekdays" | "weekly" | "once" | "custom";

/** Repeat's choices as its menu names them. */
const FREQUENCY_NAMES: Record<Frequency, string> = {
  interval: "Interval", daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", once: "Once", custom: "Custom",
};

/** The task's own schedule where Repeat can't say it otherwise: its cadence, null where none says it, and its expression in words. */
interface Own {
  cadence: Cadence | null;
  words: string;
}

/** What Repeat holds: how often; Interval's count of minutes, as typed; Weekly's day; and the task's own schedule. */
interface Repeat {
  frequency: Frequency;
  every: string;
  day: Weekday;
  own: Own | null;
}

/**
 * Repeat over a schedule, with Starts. A rate of minutes is an Interval; a calendar schedule is Daily, Weekdays or
 * Weekly at Starts' time of day; any other, a rate of hours or days among them, is Custom.
 */
function repeatOf(schedule: string, cadence: Cadence | null, starts: string): Repeat {
  const of = (frequency: Frequency, changes: Partial<Repeat> = {}): Repeat => ({
    frequency, every: "30", day: weekdayOf(starts) ?? "MON", own: null, ...changes,
  });
  switch (cadence?.frequency) {
    case "once":
    case "daily":
    case "weekdays":
      return of(cadence.frequency);
    case "minutes":
      return of("interval", { every: String(cadence.every) });
    case "weekly": {
      const [day] = cadence.days;
      if (cadence.days.length === 1 && day !== undefined) return of("weekly", { day });
    }
  }
  return of("custom", { own: { cadence, words: describeSchedule(schedule) } });
}

/** The task's own cadence with Starts: its time of day, where it has one, is Starts'. */
function ownCadence(own: Own | null, starts: string): Cadence | null {
  const cadence = own?.cadence ?? null;
  return cadence !== null && "time" in cadence && cadence.frequency !== "once" ? { ...cadence, time: starts.slice(11) } : cadence;
}

/** Custom's words: the task's own schedule, at Starts' time of day where it has one. Custom with none throws. */
function ownWords(own: Own | null, starts: string): string {
  if (own === null) throw new Error("Custom has no schedule of its own");
  const cadence = ownCadence(own, starts);
  return cadence === null ? own.words : repeatsWords(cadence);
}

/**
 * The cadence and expression Repeat makes with Starts, and its first run (an ISO instant), or why it makes none yet.
 * The task's own schedule where none says it makes neither, so it stays as written.
 */
function pickedSchedule(repeat: Repeat, starts: string, timezone: string): { cadence: Cadence | null; expression: string | null; start: string } | { why: string } {
  let start: string;
  try {
    start = stopInstant(starts, timezone);
  } catch {
    return { why: `${repeat.frequency === "once" ? "Time" : "Starts"} needs a date and time` };
  }
  const time = starts.slice(11);
  const made = (cadence: Cadence | null) => ({ cadence, expression: cadence === null ? null : toExpression(cadence), start });
  switch (repeat.frequency) {
    case "interval": {
      if (!/^[1-9]\d*$/.test(repeat.every)) return { why: "Every needs a whole number from 1" };
      return made({ frequency: "minutes", every: Number(repeat.every) });
    }
    case "once":
      return made({ frequency: "once", date: starts.slice(0, 10), time });
    case "daily":
    case "weekdays":
      return made({ frequency: repeat.frequency, time });
    case "weekly":
      return made({ frequency: "weekly", time, days: [repeat.day] });
    case "custom":
      return made(ownCadence(repeat.own, starts));
  }
}

/** A settings row (DESIGN.md) choosing from a list: its choice muted at the right, over a chevron. */
function SelectRow({ label, value, disabled, onChange, children }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="settings-row">
      <span>{label}</span>
      <span className="settings-select">
        <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <ChevronDown size={16} aria-hidden />
      </span>
    </label>
  );
}

/** A date and time, or its time of day alone, in words with the zone; Choose while it isn't one, as the line under the rows says why. */
function whenWords(value: string, timezone: string, time: boolean): string {
  try {
    if (!time) return wallWords(value, timezone);
    const at = Date.parse(stopInstant(value, timezone));
    return `${clock(value.slice(11))} ${zoneName(timezone, at)}`;
  } catch {
    return "Choose";
  }
}

/**
 * A settings row holding a date and time (YYYY-MM-DDTHH:MM), or with `time` only its time of day, shown as words over
 * a chevron as Codex's Time is: a native picker lies unseen over the whole row, so a tap anywhere on it opens the picker.
 */
function WhenRow({ label, value, time = false, timezone, disabled, onChange }: {
  label: string;
  value: string;
  time?: boolean;
  timezone: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-row settings-when">
      <span>{label}</span>
      <span className="settings-select" aria-hidden>
        <span>{whenWords(value, timezone, time)}</span>
        <ChevronDown size={16} />
      </span>
      <input
        type={time ? "time" : "datetime-local"}
        aria-label={label}
        disabled={disabled}
        value={time ? value.slice(11) : value}
        // A desktop browser opens its picker only from its own calendar icon, hidden here, unless asked; Safari before 16.4 can't be.
        onClick={(event) => {
          if ("showPicker" in event.currentTarget) event.currentTarget.showPicker();
        }}
        onChange={({ target }) => {
          if (!time) onChange(target.value);
          else if (target.value) onChange(`${value.slice(0, 10)}T${target.value}`);
        }}
      />
    </div>
  );
}

/** Repeat, as Codex's: one menu of how often; Custom only for a task whose own schedule none of the others says. */
function RepeatRow({ value, disabled, onChange }: { value: Repeat; disabled: boolean; onChange: (value: Repeat) => void }) {
  return (
    <SelectRow label="Repeat" value={value.frequency} disabled={disabled} onChange={(frequency) => onChange({ ...value, frequency: frequency as Frequency })}>
      {Object.entries(FREQUENCY_NAMES)
        .filter(([frequency]) => frequency !== "custom" || value.own)
        .map(([frequency, name]) => (
          <option key={frequency} value={frequency}>
            {name}
          </option>
        ))}
    </SelectRow>
  );
}

/**
 * Interval's Every, as Codex's: the count of minutes bare and edited in place, with no box, then minutes, muted; a tap
 * anywhere on the row puts the caret in the count.
 */
function EveryRow({ value, disabled, onChange }: { value: Repeat; disabled: boolean; onChange: (value: Repeat) => void }) {
  return (
    <label className="settings-row">
      <span>Every</span>
      <span className="settings-every">
        <input
          aria-label="Every"
          inputMode="numeric"
          disabled={disabled}
          value={value.every}
          style={{ width: `${Math.max(value.every.length, 1) + 0.5}ch` }}
          onChange={(event) => onChange({ ...value, every: event.target.value.replace(/\D/g, "") })}
        />
        <span>{unitOf("minute", Number(value.every))}</span>
      </span>
    </label>
  );
}

/**
 * Repeat and the row it needs, as label and words, as Edit's shut card shows them: a task's sheet reads them, so the
 * two say one thing.
 */
function repeatRows(repeat: Repeat, starts: string, timezone: string): [string, string][] {
  const head: [string, string] = ["Repeat", FREQUENCY_NAMES[repeat.frequency]];
  switch (repeat.frequency) {
    case "interval":
      return [head, ["Every", `${repeat.every} ${unitOf("minute", Number(repeat.every))}`]];
    case "weekly":
      return [head, ["Day", dayName(repeat.day)], ["Time", whenWords(starts, timezone, true)]];
    case "daily":
    case "weekdays":
      return [head, ["Time", whenWords(starts, timezone, true)]];
    case "once":
      return [head, ["Time", whenWords(starts, timezone, false)]];
    case "custom":
      return [head, ["Schedule", ownWords(repeat.own, starts)]];
  }
}

/**
 * How a task ends as Ends shows it: Never, or its date and time in the task's time zone. A task made with a count of
 * runs ends at the last of them, which follows Starts and Repeat, until another date is picked.
 */
interface Ends {
  choice: "never" | "on";
  on: string;
  /** The task's count of runs while its end is the last of them; null once a date is picked. */
  count: number | null;
}

/**
 * The stop time an ending saves: null for Never, else its instant; none for a count of runs, which the task keeps, as
 * its last tick is a stop time Scheduler may not fire at.
 */
function stopOf(ending: Ending): string | null | undefined {
  switch (ending.kind) {
    case "never":
      return null;
    case "on":
      return new Date(ending.at).toISOString();
    case "after":
      return undefined;
  }
}

/** The date and time (YYYY-MM-DDTHH:MM) Ends holds: a counted task's last run where its schedule says it; none for Never. */
function endsOn(value: Ends, counted: string | undefined): string {
  return value.choice === "on" ? (counted ?? value.on) : "";
}

/**
 * Ends in words, as its row and a task's sheet say it: Never, or its date and time; a counted task whose last run
 * can't be said yet ends after its count.
 */
function endsWords(value: Ends, counted: string | undefined, timezone: string): string {
  const on = endsOn(value, counted);
  if (on) return wallWords(on, timezone);
  return value.choice === "on" && value.count !== null ? `After ${value.count} ${unitOf("run", value.count)}` : "Never";
}

/**
 * Ends, as iOS Calendar's End Repeat: one row reading Never or the end's date and time, a counted task's last run until
 * another is picked. Its menu offers Never and On a date…, which opens the native picker unseen under the row; the
 * date picked becomes the row's value, and a picker shut with none leaves the row as it was.
 */
function EndsRow({ value, counted, timezone, disabled, onChange }: {
  value: Ends;
  /** A counted task's last run (YYYY-MM-DDTHH:MM), where its schedule says. */
  counted: string | undefined;
  timezone: string;
  disabled: boolean;
  onChange: (value: Ends) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  // Where the browser can't open a picker when asked (Safari before 16.4), the picker takes the row's taps instead.
  const [direct, setDirect] = useState(false);
  const on = endsOn(value, counted);
  const never: Ends = { choice: "never", on: "", count: null };
  return (
    <div className={direct ? "settings-row settings-ends settings-ends-direct" : "settings-row settings-ends"}>
      <span>Ends</span>
      <span className="settings-select">
        {/* The row's value is a hidden choice, so picking either option, even On a date… again, is a change. */}
        <select
          aria-label="Ends"
          disabled={disabled}
          value=""
          onChange={(event) => {
            const input = picker.current;
            if (event.target.value === "never") onChange(never);
            else if (input !== null) {
              // lib.dom gives every input showPicker, which Safari before 16.4 lacks.
              if (typeof (input as { showPicker?: unknown }).showPicker === "function") input.showPicker();
              else {
                setDirect(true);
                input.focus();
                input.click();
              }
            }
          }}
        >
          <option value="" hidden>
            {endsWords(value, counted, timezone)}
          </option>
          <option value="never">Never</option>
          <option value="on">On a date…</option>
        </select>
        <ChevronDown size={16} aria-hidden />
      </span>
      <input
        ref={picker}
        type="datetime-local"
        aria-label="End date"
        tabIndex={-1}
        disabled={disabled}
        value={on}
        onChange={(event) => onChange(event.target.value ? { choice: "on", on: event.target.value, count: null } : never)}
      />
    </div>
  );
}

interface Draft {
  title: string;
  prompt: string;
  model: string;
  repeat: Repeat;
  /** More is open, showing Starts, Ends and the model. */
  more: boolean;
  /** The first run as Starts shows it: a date and time (YYYY-MM-DDTHH:MM) in the task's time zone. */
  starts: string;
  ends: Ends;
  /** Starts, the expression Repeat made and the stop time and count of runs Ends picked, as Edit opened them: Save sends only what moved. */
  opened: { starts: string; expression: string | null; endDate: string | null; maxRuns: number | null };
}

/**
 * Starts as Edit opens it: a one-off's date and time, else the date of the task's first run, or of its next one for a
 * task from before tasks kept their first, or today, at the time of day it runs, or at the time it starts for a rate.
 */
function startsOf(task: ScheduledTask, cadence: Cadence | null, now: number): string {
  if (cadence?.frequency === "once") return `${cadence.date}T${cadence.time}`;
  const wall = wallTime(task.startDate ?? task.nextRun ?? now, task.timezone);
  return cadence !== null && "time" in cadence ? `${wall.slice(0, 10)}T${cadence.time}` : wall;
}

/**
 * The Edit form over a task, More shut: Repeat on its schedule; Ends On its last run for a counted task, else On
 * its stop time, else Never.
 */
function draftOf(task: ScheduledTask, model: string): Draft {
  const now = Date.now();
  const cadence = fromExpression(task.schedule);
  const starts = startsOf(task, cadence, now);
  const repeat = repeatOf(task.schedule, cadence, starts);
  // The expression Repeat makes as it opens, so a task Save leaves alone sends none.
  const made = pickedSchedule(repeat, starts, task.timezone);
  const on = task.endDate ? wallTime(task.endDate, task.timezone) : "";
  const ends: Ends = { choice: task.maxRuns != null || task.endDate ? "on" : "never", on, count: task.maxRuns ?? null };
  return {
    title: task.title, prompt: task.prompt, model, repeat, more: false, starts, ends,
    opened: {
      starts,
      expression: "why" in made ? null : made.expression,
      endDate: task.endDate ? stopInstant(on, task.timezone) : null,
      maxRuns: task.maxRuns ?? null,
    },
  };
}

/** A change to a task: its fields, with a start, a stop time or a count of runs cleared with null. */
type TaskChanges = Partial<Omit<ScheduledTask, "startDate" | "endDate" | "maxRuns">> & {
  startDate?: string | null;
  endDate?: string | null;
  maxRuns?: number | null;
};

/**
 * What Repeat and Starts save, with the cadence and first run a counted ending follows, or why they can't yet. A
 * schedule none of the controls says stays as written while Repeat keeps it as Custom.
 */
function editedSchedule(draft: Draft, task: ScheduledTask): { changes: TaskChanges; cadence: Cadence | null; start: number } | { why: string } {
  const made = pickedSchedule(draft.repeat, draft.starts, task.timezone);
  if ("why" in made) return made;
  const changes: TaskChanges = {};
  if (made.expression !== null && made.expression !== draft.opened.expression) changes.schedule = made.expression;
  // A new schedule, as a one-off made to repeat has, starts at Starts: a rate would otherwise count from its creation.
  const moved = made.start !== stopInstant(draft.opened.starts, task.timezone) || changes.schedule !== undefined;
  if (made.cadence?.frequency === "once") {
    if (task.startDate !== undefined) changes.startDate = null;
  } else if (moved) changes.startDate = made.start;
  return { changes, cadence: made.cadence, start: Date.parse(made.start) };
}

/**
 * The ending Ends picks on the cadence and first run Repeat and Starts make: a counted task's last run, no later than
 * the date Ends holds; a one-off has nothing to end.
 */
function endingOf(draft: Draft, task: ScheduledTask, cadence: Cadence | null, start: number): Ending {
  const { ends } = draft;
  if (cadence?.frequency === "once" || ends.choice === "never") return { kind: "never" };
  if (ends.count === null) return { kind: "on", at: Date.parse(stopInstant(ends.on, task.timezone)) };
  const counted = countedEnding(task, ends.count, cadence, start, task.timezone);
  return ends.on && counted.last !== undefined ? { ...counted, last: Math.min(counted.last, Date.parse(stopInstant(ends.on, task.timezone))) } : counted;
}

/**
 * What Save sends, with the ending it picks, or why it can't yet. It sends the title and prompt, and only what else
 * moved: a task keeps its expression as written, its start, its ending and the account's default model until the
 * controls pick another. A counted task keeps its count until Ends picks Never or a date, which it sends with no count;
 * a one-off has nothing to end.
 */
function edited(draft: Draft, task: ScheduledTask, model: string): { changes: TaskChanges; ending: Ending } | { why: string } {
  const schedule = editedSchedule(draft, task);
  if ("why" in schedule) return schedule;
  const ending = endingOf(draft, task, schedule.cadence, schedule.start);

  const changes: TaskChanges = { title: draft.title, prompt: draft.prompt, ...schedule.changes };
  const endDate = stopOf(ending);
  if (endDate !== undefined && (endDate !== draft.opened.endDate || draft.opened.maxRuns !== null)) Object.assign(changes, { endDate });
  if (draft.model !== model) changes.model = draft.model;
  return { changes, ending };
}

interface ModelChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * The models a task's runs can use, as Model offers them and a task's sheet reads them: the account's, with the one it
 * names marked when the account no longer has it, and the task's own while the account's are unknown.
 */
function modelChoices(task: ScheduledTask, models: AgentModel[] | null, modelsFailed: boolean, runsOn: string | undefined): ModelChoice[] {
  const choices: ModelChoice[] = [];
  if (models === null || (modelsFailed && runsOn === undefined)) choices.push({ value: runsOn ?? "", label: `${task.model ?? "Account default"} (models unavailable)` });
  // A named model the account no longer has: its runs fail, so it shows as unavailable.
  if (task.model !== undefined && models !== null && !models.some(({ key }) => key === task.model)) {
    choices.push({ value: task.model, label: `${task.model} (${modelsFailed ? "models unavailable" : "unavailable"})`, disabled: true });
  }
  return [...choices, ...(models ?? []).map(({ key, label }) => ({ value: key, label }))];
}

/** The model a task's runs use, one of its model choices. */
function ModelRow({ task, models, modelsFailed, runsOn, value, disabled, onChange }: {
  task: ScheduledTask;
  models: AgentModel[] | null;
  modelsFailed: boolean;
  runsOn: string | undefined;
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <SelectRow label="Model" value={value} disabled={disabled || models === null} onChange={onChange}>
      {modelChoices(task, models, modelsFailed, runsOn).map((choice) => (
        <option key={choice.value} value={choice.value} disabled={choice.disabled}>
          {choice.label}
        </option>
      ))}
    </SelectRow>
  );
}

/** A counted task's last run as Ends holds it (YYYY-MM-DDTHH:MM), where the draft says it. */
function countedWall(ending: Ending | undefined, timezone: string): string | undefined {
  return ending?.kind === "after" && ending.last !== undefined ? wallTime(ending.last, timezone) : undefined;
}

/**
 * The Edit form, after Codex's Schedule a task (DESIGN.md): the title and what it asks; then one card, Repeat and what
 * it needs: Interval's Every, Weekly's Day, a calendar schedule's Time, Once's date and time, or Custom's own words;
 * then More, shut, over Starts, Ends and the model; then, while Save can't, why, over Cancel and Save. Its times
 * are in the task's time zone.
 */
function TaskEditForm({ task, models, modelsFailed, runsOn, notices, onChange, onDone }: {
  task: ScheduledTask;
  models: AgentModel[] | null;
  modelsFailed: boolean;
  /** The model its runs use; unknown while the catalog failed and it names none. */
  runsOn: string | undefined;
  notices: ReactNode;
  onChange: (changes: TaskChanges) => Promise<boolean>;
  onDone: () => void;
}) {
  const model = runsOn ?? "";
  const [draft, setDraft] = useState(() => draftOf(task, model));
  const [saving, setSaving] = useState(false);
  const set = (changes: Partial<Draft>) => setDraft({ ...draft, ...changes });
  const save = edited(draft, task, model);
  const { frequency } = draft.repeat;
  return (
    <div className="scheduled-sheet-body scheduled-edit">
      <input className="settings-text" aria-label="Title" placeholder="Title" disabled={saving} value={draft.title} onChange={(event) => set({ title: event.target.value })} />
      <textarea
        className="settings-text"
        aria-label="Prompt"
        placeholder="Instructions…"
        rows={4}
        disabled={saving}
        value={draft.prompt}
        onChange={(event) => set({ prompt: event.target.value })}
      />
      <div className="settings-group">
        <RepeatRow value={draft.repeat} disabled={saving} onChange={(repeat) => set({ repeat })} />
        {frequency === "interval" && <EveryRow value={draft.repeat} disabled={saving} onChange={(repeat) => set({ repeat })} />}
        {frequency === "weekly" && (
          <SelectRow label="Day" value={draft.repeat.day} disabled={saving} onChange={(day) => set({ repeat: { ...draft.repeat, day: day as Weekday } })}>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={day}>
                {DAY_NAMES[index]}
              </option>
            ))}
          </SelectRow>
        )}
        {(frequency === "daily" || frequency === "weekdays" || frequency === "weekly") && (
          <WhenRow label="Time" time value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} />
        )}
        {frequency === "once" && <WhenRow label="Time" value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} />}
        {frequency === "custom" && (
          <div className="settings-row">
            <span>Schedule</span>
            {/* Custom says its time of day, which follows Starts. */}
            <span>{ownWords(draft.repeat.own, draft.starts)}</span>
          </div>
        )}
      </div>
      <More open={draft.more} onToggle={() => set({ more: !draft.more })}>
        <div className="settings-group">
          {frequency !== "once" && (
            <>
              <WhenRow label="Starts" value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} />
              <EndsRow value={draft.ends} counted={countedWall("ending" in save ? save.ending : undefined, task.timezone)} timezone={task.timezone} disabled={saving} onChange={(ends) => set({ ends })} />
            </>
          )}
          <ModelRow task={task} models={models} modelsFailed={modelsFailed} runsOn={runsOn} value={draft.model} disabled={saving} onChange={(picked) => set({ model: picked })} />
        </div>
      </More>
      {"why" in save && (
        <p className="scheduled-task-hint" role="status">
          {save.why}
        </p>
      )}
      {notices}
      <div className="scheduled-edit-actions">
        <Button disabled={saving} onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          disabled={saving || "why" in save}
          onClick={async () => {
            if ("why" in save) return;
            setSaving(true);
            const saved = await onChange(save.changes);
            setSaving(false);
            if (saved) onDone();
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * An open task's sheet: what it asks and when, with Pause or Resume, Edit and Delete (spec story 52). Editing turns it
 * into the task's fields: what it asks; how it repeats, starts and ends; in which time zone; and on which model, over a
 * line saying it in words. Delete asks first, as iOS does.
 */
function ScheduledTaskSheet({
  task,
  editing,
  onEditing,
  models,
  modelsFailed,
  notices,
  onChange,
  onDelete,
  onOpenChat,
}: {
  task: ScheduledTask;
  /** Showing the Edit form, which the sheet's title names Edit task. */
  editing: boolean;
  onEditing: (editing: boolean) => void;
  /** The account's models, the default first; null until they load; only the Cartridge's, or null, when the catalog failed. */
  models: AgentModel[] | null;
  /** The account's catalog failed (`notices` say why): the task stays editable on the model it names. */
  modelsFailed: boolean;
  /** Why a change or the model catalog failed. */
  notices: ReactNode;
  onChange: (changes: TaskChanges) => Promise<boolean>;
  onDelete: () => void;
  /** Opens the task's Side Chat, whose ID is the task's. */
  onOpenChat: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The model its runs use: the one it names, else the account's default; unknown until the models load.
  const runsOn = modelsFailed ? task.model : models === null ? undefined : (task.model ?? models[0]?.key);

  if (editing) {
    return (
      <TaskEditForm
        task={task}
        models={models}
        modelsFailed={modelsFailed}
        runsOn={runsOn}
        notices={notices}
        onChange={onChange}
        onDone={() => onEditing(false)}
      />
    );
  }
  return (
    <div className="scheduled-sheet-body">
      <p className="scheduled-task-prompt">{task.prompt}</p>
      <TaskDetails task={task} models={models} modelsFailed={modelsFailed} runsOn={runsOn} />
      {notices}
      {confirmingDelete ? (
        <div className="scheduled-sheet-actions">
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmingDelete(false);
              onDelete();
            }}
          >
            Delete task
          </Button>
          <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="scheduled-sheet-actions">
          {task.sideChat && <Button onClick={onOpenChat}>Open chat</Button>}
          {!task.ended && <Button onClick={() => void onChange({ paused: !task.paused })}>{task.paused ? "Resume" : "Pause"}</Button>}
          <Button disabled={runsOn === undefined && !modelsFailed} onClick={() => onEditing(true)}>
            Edit
          </Button>
          <Button variant="destructive" onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

/** One listed task (Muse Fig 15): its icon, its title, and one line of when and what; a tap opens its sheet. */
function ScheduledTaskRow({ task, onOpen }: { task: ScheduledTask; onOpen: () => void }) {
  const { time } = listing(task.schedule);
  return (
    <li>
      <ListRow
        render={<button type="button" aria-haspopup="dialog" onClick={onOpen} />}
        className={task.paused || task.ended ? "scheduled-task scheduled-task-paused" : "scheduled-task"}
      >
        <ListRowIcon>
          <CalendarClock size={20} />
        </ListRowIcon>
        <ListRowText className="scheduled-task-text">
          {/* A paused or ended task says so in a pill beside its name, as a Sign-ins row states its link. */}
          <span className="scheduled-task-heading">
            <ListRowTitle className="scheduled-task-title">{task.title}</ListRowTitle>
            <TaskStatus task={task} />
          </span>
          <ListRowDetail className="scheduled-task-detail">{time === undefined ? task.prompt : `${time} · ${task.prompt}`}</ListRowDetail>
        </ListRowText>
      </ListRow>
    </li>
  );
}

/** The Scheduled tab: the account's recurring tasks under their frequency labels, loaded each time it opens. */
export function ScheduledPanel({
  chatServiceUrl,
  onOpenChat,
}: {
  chatServiceUrl: string;
  /** Opens a task's Side Chat, by the task's ID and title. */
  onOpenChat: (id: string, title: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [models, setModels] = useState<AgentModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The task whose sheet is open, kept while it closes so it still shows as it slides away.
  const [sheet, setSheet] = useState<{ task: ScheduledTask; open: boolean; editing: boolean } | null>(null);
  // The sheet rises over the Agent Profile, as its phone sheet covers the screen.
  const [profile, setProfile] = useState<HTMLElement | null>(null);
  const panelRef = useCallback((node: HTMLElement | null) => setProfile(node?.closest<HTMLElement>(".agent-profile") ?? null), []);

  useEffect(
    () => {
      listTasks(chatServiceUrl).then(setTasks, (failure: Error) => setError(failure.message));
      fetchAgentModels({ chatServiceUrl }).then(setModels, (failure: Error) => {
        setModelsError(failure.message);
        if (failure instanceof ModelCatalogError) setModels(failure.cartridgeModels);
      });
    },
    // Stryker disable next-line ArrayDeclaration: the Chat Service URL never changes, so any list loads once per open
    [chatServiceUrl],
  );

  const change = async (id: string, changes: TaskChanges) => {
    setError(null);
    try {
      const updated = await sendTask(chatServiceUrl, `/scheduled-tasks/${id}`, "PATCH", changes, "Scheduled task change failed");
      setTasks((current) => (current ?? []).map((task) => (task.id === id ? updated : task)));
      setSheet((current) => (current?.task.id === id ? { ...current, task: updated } : current));
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };

  const remove = async ({ id, title }: ScheduledTask) => {
    setError(null);
    // The tab says so in plain words; the console keeps why, as a file that could not load does.
    const failed = (why: string, cause?: unknown) => {
      console.error(new Error(`Deleting ${title} failed: ${why}`, cause === undefined ? undefined : { cause }));
      setError(`Couldn't delete ${title}. Try again.`);
    };
    let response: Response;
    try {
      response = await fetch(`${chatServiceUrl}/scheduled-tasks/${id}`, { method: "DELETE", credentials: "include" });
    } catch (failure) {
      failed((failure as Error).message, failure);
      return;
    }
    if (!response.ok) {
      failed(String(response.status));
      if (response.status !== 404) return;
    }
    setTasks((current) => (current ?? []).filter((task) => task.id !== id));
    setSheet((current) => (current?.task.id === id ? { ...current, open: false } : current));
  };

  // Shown in the open sheet, which covers the tab, or else in the tab.
  const notices = (
    <>
      {error && <p className="agent-profile-error">{error}</p>}
      {modelsError && <p className="agent-profile-error">{modelsError}</p>}
    </>
  );
  const groups = byFrequency(tasks ?? []);
  return (
    <div className="scheduled" ref={panelRef}>
      {!sheet?.open && notices}
      {tasks?.length === 0 && <p className="agent-profile-empty">No scheduled tasks yet.</p>}
      {groups.length > 0 && (
        <div className="scheduled-tasks">
          {groups.map(({ label, tasks: grouped }) => (
            <section key={label} aria-label={label}>
              <h3 className="list-group-heading">{label}</h3>
              <ul className="scheduled-task-list">
                {grouped.map((task) => (
                  <ScheduledTaskRow
                    key={task.id}
                    task={task}
                    onOpen={() => {
                      // A failure belongs to the task it was for; another task's sheet starts clear of it.
                      setError(null);
                      setSheet({ task, open: true, editing: false });
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {sheet && (
        <Sheet open={sheet.open} onClose={() => setSheet((current) => current && { ...current, open: false })} title={sheet.editing ? "Edit task" : sheet.task.title} container={profile} className="scheduled-sheet">
          <ScheduledTaskSheet
            key={sheet.task.id}
            task={sheet.task}
            editing={sheet.editing}
            onEditing={(editing) => setSheet((current) => current && { ...current, editing })}
            models={models}
            modelsFailed={modelsError !== null}
            notices={notices}
            onChange={(changes) => change(sheet.task.id, changes)}
            onDelete={() => void remove(sheet.task)}
            onOpenChat={() => onOpenChat(sheet.task.id, sheet.task.title)}
          />
        </Sheet>
      )}
    </div>
  );
}
