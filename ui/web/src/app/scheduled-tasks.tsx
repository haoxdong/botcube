"use client";

import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { Sheet } from "../components/ui/sheet";
import { StatusPill } from "../components/ui/status-pill";
import { fetchAgentModels, ModelCatalogError, type AgentModel } from "./conversations";
import { throwIfRefused } from "./refusal";
import {
  DAY_NAMES, WEEKDAYS, describeEnd, describeSchedule, fromExpression, listing, stopInstant, toExpression, wallTime, type Cadence, type Weekday,
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

/**
 * What the agent proposes, as its `propose_scheduled_task` tool call carries it: the Edit form's fields, or, from
 * before proposals carried them, a Scheduler expression; any stop time, as a date and time (YYYY-MM-DDTHH:MM); and any
 * count of runs it makes before it stops.
 */
export type ScheduledTaskProposal = { title: string; prompt: string; ends?: string | null; count?: number | null } & (Cadence | { schedule: string });

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
  /** The stop time, an ISO instant, after which the task no longer runs. */
  endDate?: string;
  /** How many runs it makes before it leaves the account. */
  maxRuns?: number;
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

/**
 * The agent's proposal as a card the user confirms; confirming schedules it in the browser's timezone.
 * The proposal's tool call ID names it, so a card confirmed again answers the task it already made,
 * and a card whose proposal the account's tasks already hold shows it scheduled.
 */
export function ScheduledTaskProposalCard({
  chatServiceUrl,
  proposalId,
  proposal,
}: {
  chatServiceUrl: string;
  proposalId: string;
  proposal: ScheduledTaskProposal;
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

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The proposal's expression and stop time, or why its fields make none.
  let schedule: string | null = null;
  let endDate: string | undefined;
  let unscheduled: string | null = null;
  try {
    schedule = "schedule" in proposal ? proposal.schedule : toExpression(proposal);
    // A field sent as null is unused, as the Harness reads it.
    if (proposal.ends != null) endDate = stopInstant(proposal.ends, timezone);
  } catch (failure) {
    schedule = null;
    unscheduled = `This proposal has no schedule: ${(failure as Error).message}`;
  }

  const confirm = async (schedule: string) => {
    setState("busy");
    setError(null);
    try {
      const { title, prompt, count } = proposal;
      // A field sent as null is unused, as the Harness reads it.
      const task = { title, prompt, schedule, timezone, ...(endDate === undefined ? {} : { endDate }), ...(count == null ? {} : { maxRuns: count }), proposalId };
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
          <ScheduleWords schedule={schedule} timezone={timezone} element="p" />
          {endDate !== undefined && <StopWords endDate={endDate} timezone={timezone} />}
          {proposal.count != null && <RunCountWords maxRuns={proposal.count} />}
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

/**
 * The task's next run, or Ended, Paused or Unknown, and how its last run ended, each time in the task's time zone (spec story 73).
 */
function TaskRuns({ task }: { task: ScheduledTask }) {
  const when = (at: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: task.timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(at));
  // A schedule the Chat Service cannot read runs at a time it can't say: Unknown, with why on hover.
  const unknown = !task.ended && !task.paused && task.nextRunUnknown !== undefined;
  const next = task.ended ? "Ended" : task.paused ? "Paused" : unknown ? "Unknown" : task.nextRun === undefined ? null : when(task.nextRun);
  const last = task.lastRun;
  return (
    <dl className="scheduled-sheet-runs">
      {next !== null && (
        <div>
          <dt>Next run</dt>
          <dd title={unknown ? task.nextRunUnknown : undefined}>{next}</dd>
        </div>
      )}
      {last && (
        <div>
          <dt>Last run</dt>
          <dd>
            {when(last.at)}
            <StatusPill tone={RUN_STATUS[last.status].tone}>{RUN_STATUS[last.status].label}</StatusPill>
          </dd>
        </div>
      )}
    </dl>
  );
}

/** A schedule in plain words and its time zone. The separator wraps with the zone it introduces, never alone at a line's end. */
function ScheduleWords({ schedule, timezone, element: Element = "span" }: { schedule: string; timezone: string; element?: "p" | "span" }) {
  return (
    <Element className="scheduled-task-schedule">
      {describeSchedule(schedule)} <span className="scheduled-task-zone">· {timezone}</span>
    </Element>
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

/** When a task stops, or stopped, in plain words in its time zone. */
function StopWords({ endDate, timezone }: { endDate: string; timezone: string }) {
  return <p className="scheduled-task-ends">{describeEnd(endDate, timezone)}</p>;
}

/** How many runs a task makes before it stops. */
function RunCountWords({ maxRuns }: { maxRuns: number }) {
  return <p className="scheduled-task-ends">Stops after {maxRuns} {maxRuns === 1 ? "run" : "runs"}</p>;
}

/** The Edit form's schedule controls, as typed: a frequency, N, a time, days and a date, each kept as the frequency changes. */
interface Picked {
  frequency: Cadence["frequency"];
  every: string;
  time: string;
  days: Weekday[];
  date: string;
}

const FREQUENCIES: [Cadence["frequency"], string][] = [
  ["minutes", "Every N minutes"],
  ["hours", "Every N hours"],
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["once", "Once"],
];

/** The controls showing a schedule; null when they can't show it. */
function picked(schedule: string): Picked | null {
  const cadence = fromExpression(schedule);
  if (cadence === null) return null;
  return {
    every: "every" in cadence ? String(cadence.every) : "1",
    time: "time" in cadence ? cadence.time : "09:00",
    days: "days" in cadence ? cadence.days : ["MON"],
    date: "date" in cadence ? cadence.date : new Date().toISOString().slice(0, 10),
    frequency: cadence.frequency,
  };
}

/** The expression the controls make, or why they make none yet. */
function pickedExpression({ frequency, every, time, days, date }: Picked): { expression: string } | { why: string } {
  try {
    if (frequency === "minutes" || frequency === "hours") return { expression: toExpression({ frequency, every: Number(every) }) };
    if (frequency === "once") return { expression: toExpression({ frequency, date, time }) };
    return { expression: toExpression(frequency === "weekly" ? { frequency, time, days } : { frequency, time }) };
  } catch (failure) {
    return { why: (failure as Error).message };
  }
}

/** The time zones a task can run in, its own among them. */
function timeZones(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

/** Frequency, then N or the time, then on Weekly the days or on Once the date, as the Scheduled list labels them. */
function SchedulePicker({ value, disabled, onChange }: { value: Picked; disabled: boolean; onChange: (value: Picked) => void }) {
  const interval = value.frequency === "minutes" || value.frequency === "hours";
  const daysLabel = useId();
  return (
    <>
      <div className="scheduled-task-row">
        <Field className="scheduled-task-field" label="Frequency">
          <select disabled={disabled} value={value.frequency} onChange={(event) => onChange({ ...value, frequency: event.target.value as Picked["frequency"] })}>
            {FREQUENCIES.map(([frequency, label]) => (
              <option key={frequency} value={frequency}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {interval ? (
          <Field className="scheduled-task-field" label="Every">
            <input type="number" inputMode="numeric" min={1} disabled={disabled} value={value.every} onChange={(event) => onChange({ ...value, every: event.target.value })} />
          </Field>
        ) : (
          <Field className="scheduled-task-field" label="Time">
            <input type="time" disabled={disabled} value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value })} />
          </Field>
        )}
      </div>
      {value.frequency === "once" && (
        <Field className="scheduled-task-field" label="Date">
          <input type="date" disabled={disabled} value={value.date} onChange={(event) => onChange({ ...value, date: event.target.value })} />
        </Field>
      )}
      {value.frequency === "weekly" && (
        <div className="scheduled-task-field field">
          <span id={daysLabel}>Days</span>
          <div className="scheduled-days" role="group" aria-labelledby={daysLabel}>
            {WEEKDAYS.map((day, index) => {
              const on = value.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className="scheduled-day"
                  aria-label={DAY_NAMES[index]}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => onChange({ ...value, days: on ? value.days.filter((other) => other !== day) : [...value.days, day] })}
                >
                  {DAY_NAMES[index]?.[0]}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

interface Draft {
  title: string;
  prompt: string;
  timezone: string;
  model: string;
  /** Null for a schedule the controls can't show, which stays as it is. */
  schedule: Picked | null;
  /** What the controls made of the task's schedule when Edit opened: saved unchanged, the expression stays as written. */
  unchanged: string | null;
  /** The stop time as Ends shows it, a date and time in the draft's time zone; empty for none. */
  ends: string;
}

/** The model a task's runs use: the account's, with the one it names marked when the account no longer has it. */
function ModelField({ task, models, modelsFailed, runsOn, value, disabled, onChange }: {
  task: ScheduledTask;
  models: AgentModel[] | null;
  modelsFailed: boolean;
  runsOn: string | undefined;
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  // A named model the account no longer has: its runs fail, so it shows as unavailable.
  const unavailable = task.model !== undefined && models !== null && !models.some(({ key }) => key === task.model);
  return (
    <Field className="scheduled-task-field" label="Model">
      <select disabled={disabled || models === null} value={value} onChange={(event) => onChange(event.target.value)}>
        {(models === null || (modelsFailed && runsOn === undefined)) && <option value={runsOn ?? ""}>{task.model ?? "Account default"} (models unavailable)</option>}
        {unavailable && (
          <option value={task.model} disabled>
            {task.model} ({modelsFailed ? "models unavailable" : "unavailable"})
          </option>
        )}
        {(models ?? []).map(({ key, label }) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A change to a task: its fields, and a stop time cleared with null. */
type TaskChanges = Partial<Omit<ScheduledTask, "endDate">> & { endDate?: string | null };

/**
 * The stop time Save sends, or why Ends makes none: an instant, or null for none. A once task has nothing to stop.
 */
function draftStop(draft: Draft): { endDate: string | null } | { why: string } {
  if (draft.schedule?.frequency === "once" || draft.ends === "") return { endDate: null };
  try {
    return { endDate: stopInstant(draft.ends, draft.timezone) };
  } catch (failure) {
    return { why: (failure as Error).message };
  }
}

/**
 * What Save changes: the title and prompt, and only what the controls changed. A task keeps its expression as written,
 * its time zone, its stop time, and the account's default model, until the controls pick another.
 */
function edited(draft: Draft, schedule: string | null, endDate: string | null, task: ScheduledTask, model: string): TaskChanges {
  return {
    title: draft.title,
    prompt: draft.prompt,
    ...(schedule === null || schedule === draft.unchanged ? {} : { schedule }),
    ...(draft.timezone === task.timezone ? {} : { timezone: draft.timezone }),
    ...(endDate === (task.endDate ?? null) ? {} : { endDate }),
    ...(draft.model === model ? {} : { model: draft.model }),
  };
}

/**
 * An open task's sheet: what it asks and when, with Pause or Resume, Edit and Delete (spec story 52). Editing turns it
 * into the task's fields: what it asks, when, in which time zone, and on which model. Delete asks first, as iOS does.
 */
function ScheduledTaskSheet({
  task,
  agentName,
  models,
  modelsFailed,
  notices,
  onChange,
  onDelete,
  onOpenChat,
}: {
  task: ScheduledTask;
  /** Who to ask to change a schedule the Edit form can't show. */
  agentName: string;
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The model its runs use: the one it names, else the account's default; unknown until the models load.
  const runsOn = modelsFailed ? task.model : models === null ? undefined : (task.model ?? models[0]?.key);
  const initialModel = runsOn ?? "";

  if (draft) {
    const field = (name: "title" | "prompt", label: string) => (
      <Field className="scheduled-task-field" label={label}>
        <input disabled={saving} value={draft[name]} onChange={(event) => setDraft({ ...draft, [name]: event.target.value })} />
      </Field>
    );
    // What the controls make; a schedule they can't show stays as it is.
    const made = draft.schedule === null ? { expression: task.schedule } : pickedExpression(draft.schedule);
    const schedule = "expression" in made ? made.expression : null;
    const stop = draftStop(draft);
    return (
      <div className="scheduled-sheet-body">
        {field("title", "Title")}
        {field("prompt", "Prompt")}
        {draft.schedule !== null && <SchedulePicker value={draft.schedule} disabled={saving} onChange={(picked) => setDraft({ ...draft, schedule: picked })} />}
        <Field className="scheduled-task-field" label="Time zone">
          <select disabled={saving} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
            {timeZones(task.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        {"why" in made ? <p className="scheduled-task-hint">No schedule yet: {made.why}</p> : <ScheduleWords schedule={made.expression} timezone={draft.timezone} />}
        {draft.schedule === null && <p className="scheduled-task-hint">Ask {agentName} to change it.</p>}
        {draft.schedule?.frequency !== "once" && (
          <div className="scheduled-task-row">
            <Field className="scheduled-task-field" label="Ends">
              <input type="datetime-local" disabled={saving} value={draft.ends} onChange={(event) => setDraft({ ...draft, ends: event.target.value })} />
            </Field>
            <Button className="scheduled-task-clear" disabled={saving || draft.ends === ""} onClick={() => setDraft({ ...draft, ends: "" })}>
              No stop time
            </Button>
          </div>
        )}
        {"why" in stop && <p className="scheduled-task-hint">No stop time yet: {stop.why}</p>}
        <ModelField
          task={task}
          models={models}
          modelsFailed={modelsFailed}
          runsOn={runsOn}
          value={draft.model}
          disabled={saving}
          onChange={(model) => setDraft({ ...draft, model })}
        />
        {notices}
        <div className="scheduled-sheet-edit-actions">
          <Button disabled={saving} onClick={() => setDraft(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || schedule === null || "why" in stop}
            onClick={async () => {
              if ("why" in stop) return;
              setSaving(true);
              const saved = await onChange(edited(draft, schedule, stop.endDate, task, initialModel));
              setSaving(false);
              if (saved) setDraft(null);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="scheduled-sheet-body">
      <p className="scheduled-task-prompt">{task.prompt}</p>
      <ScheduleWords schedule={task.schedule} timezone={task.timezone} />
      {/* Its Next run reads Ended once it has, over Paused, and only there (issues #3860, #3861). */}
      {task.endDate && !task.ended && <StopWords endDate={task.endDate} timezone={task.timezone} />}
      {task.maxRuns !== undefined && <RunCountWords maxRuns={task.maxRuns} />}
      <TaskRuns task={task} />
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
          <Button
            disabled={runsOn === undefined && !modelsFailed}
            onClick={() => {
              const schedule = picked(task.schedule);
              const made = schedule === null ? { expression: task.schedule } : pickedExpression(schedule);
              setDraft({
                title: task.title, prompt: task.prompt, timezone: task.timezone, model: initialModel, schedule,
                unchanged: "expression" in made ? made.expression : null,
                ends: task.endDate ? wallTime(task.endDate, task.timezone) : "",
              });
            }}
          >
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
  agentName,
  onOpenChat,
}: {
  chatServiceUrl: string;
  agentName: string;
  /** Opens a task's Side Chat, by the task's ID and title. */
  onOpenChat: (id: string, title: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [models, setModels] = useState<AgentModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The task whose sheet is open, kept while it closes so it still shows as it slides away.
  const [sheet, setSheet] = useState<{ task: ScheduledTask; open: boolean } | null>(null);
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
                      setSheet({ task, open: true });
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {sheet && (
        <Sheet open={sheet.open} onClose={() => setSheet((current) => current && { ...current, open: false })} title={sheet.task.title} container={profile} className="scheduled-sheet">
          <ScheduledTaskSheet
            key={sheet.task.id}
            task={sheet.task}
            agentName={agentName}
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
