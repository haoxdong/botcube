"use client";

import cronstrue from "cronstrue";
import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { Sheet } from "../components/ui/sheet";
import { StatusPill } from "../components/ui/status-pill";
import { fetchAgentModels, ModelCatalogError, type AgentModel } from "./conversations";
import { throwIfRefused } from "./refusal";

/** What the agent proposes, as its `propose_scheduled_task` tool call carries it. */
export interface ScheduledTaskProposal {
  title: string;
  prompt: string;
  schedule: string;
}

/** A task the agent runs on its schedule, as the Chat Service's `/scheduled-tasks` lists it. */
export interface ScheduledTask extends ScheduledTaskProposal {
  id: string;
  timezone: string;
  /** The model its runs use; absent, they use the account's default, the first of its models. */
  model?: string;
  paused: boolean;
  /** The tool call ID of the proposal the task was confirmed from. */
  proposalId: string;
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

/** The schedule in words; an expression neither `cron(...)` nor `rate(...)` reads as written. */
function describeSchedule(schedule: string): string {
  const cron = /^cron\((.+)\)$/.exec(schedule)?.[1];
  if (cron !== undefined) {
    try {
      // EventBridge numbers the days of the week from 1, Sunday. Times read as Activity's do: 7:00 AM, not 07:00 AM.
      return cronstrue.toString(cron, { dayOfWeekStartIndexZero: false, trimHoursLeadingZero: true });
    } catch {
      return schedule;
    }
  }
  const [, count, unit] = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(schedule) ?? [];
  if (count === undefined || unit === undefined) return schedule;
  return count === "1" ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** EventBridge's days of the week, numbered from 1, Sunday. */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * How often a task runs, the label the Scheduled tab lists it under (Muse Fig 15's "Daily"), and its time of day when
 * it has one. A cron at a set time on weekdays or on one day, and `rate(1 day)`, read as a frequency and a time; any
 * other schedule lists under its own words.
 */
function frequency(schedule: string): { label: string; time?: string } {
  const [, minute, hour, days] = /^cron\((\d{1,2}) (\d{1,2}) \? \* (MON-FRI|[1-7]) \*\)$/.exec(schedule) ?? [];
  if (minute !== undefined && hour !== undefined && days !== undefined) {
    const hours = Number(hour);
    const time = `${hours % 12 || 12}:${minute.padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
    return { label: days === "MON-FRI" ? "Weekdays" : `Every ${WEEKDAYS[Number(days) - 1]}`, time };
  }
  return { label: schedule === "rate(1 day)" ? "Daily" : describeSchedule(schedule) };
}

/** The tasks under their frequency labels, each label where its first task is listed. */
function byFrequency(tasks: ScheduledTask[]): { label: string; tasks: ScheduledTask[] }[] {
  const groups = new Map<string, ScheduledTask[]>();
  for (const task of tasks) {
    const { label } = frequency(task.schedule);
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

  const confirm = async () => {
    setState("busy");
    setError(null);
    try {
      const { title, prompt, schedule } = proposal;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await sendTask(chatServiceUrl, "/scheduled-tasks", "POST", { title, prompt, schedule, timezone, proposalId }, "Scheduling failed");
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
      <p className="scheduled-task-schedule">{describeSchedule(proposal.schedule)}</p>
      {state === "scheduled" ? (
        <p className="scheduled-proposal-done">Scheduled. Manage it in the Scheduled tab.</p>
      ) : (
        <Button variant="primary" className="scheduled-proposal-confirm" disabled={state === "busy"} onClick={() => void confirm()}>
          Confirm
        </Button>
      )}
      {error && <p className="agent-profile-error">{error}</p>}
    </div>
  );
}

/**
 * An open task's sheet: what it asks and when, with Pause or Resume, Edit and Delete (spec story 52). Editing turns it
 * into the task's fields: what it asks, when, and on which model. Delete asks first, as iOS does.
 */
function ScheduledTaskSheet({
  task,
  models,
  modelsFailed,
  notices,
  onChange,
  onDelete,
}: {
  task: ScheduledTask;
  /** The account's models, the default first; null until they load; only the Cartridge's, or null, when the catalog failed. */
  models: AgentModel[] | null;
  /** The account's catalog failed (`notices` say why): the task stays editable on the model it names. */
  modelsFailed: boolean;
  /** Why a change or the model catalog failed. */
  notices: ReactNode;
  onChange: (changes: Partial<ScheduledTask>) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<(ScheduledTaskProposal & { model: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The model its runs use: the one it names, else the account's default; unknown until the models load.
  const runsOn = modelsFailed ? task.model : models === null ? undefined : (task.model ?? models[0]?.key);
  const initialModel = runsOn ?? "";
  // A named model the account no longer has: its runs fail, so it shows as unavailable.
  const unavailable = task.model !== undefined && models !== null && !models.some(({ key }) => key === task.model);
  // A Schedule in plain words and the task's time zone, in the sheet and under the field being edited.
  // The separator wraps with the zone it introduces, never alone at a line's end.
  const scheduleWords = (schedule: string) => (
    <span className="scheduled-task-schedule">
      {describeSchedule(schedule)} <span className="scheduled-task-zone">· {task.timezone}</span>
    </span>
  );

  if (draft) {
    const field = (name: keyof ScheduledTaskProposal, label: string) => (
      <Field className="scheduled-task-field" label={label}>
        <input disabled={saving} value={draft[name]} onChange={(event) => setDraft({ ...draft, [name]: event.target.value })} />
      </Field>
    );
    return (
      <div className="scheduled-sheet-body">
        {field("title", "Title")}
        {field("prompt", "Prompt")}
        {field("schedule", "Schedule")}
        {scheduleWords(draft.schedule)}
        <Field className="scheduled-task-field" label="Model">
          <select disabled={saving || models === null} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {(models === null || (modelsFailed && runsOn === undefined)) && <option value={initialModel}>{task.model ?? "Account default"} (models unavailable)</option>}
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
        {notices}
        <div className="scheduled-sheet-edit-actions">
          <Button disabled={saving} onClick={() => setDraft(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              // A task keeps following the account's default until a different model is picked.
              const { model, ...fields } = draft;
              const saved = await onChange(model === initialModel ? fields : draft);
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
      {task.paused && <StatusPill>Paused</StatusPill>}
      <p className="scheduled-task-prompt">{task.prompt}</p>
      {scheduleWords(task.schedule)}
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
          <Button onClick={() => void onChange({ paused: !task.paused })}>{task.paused ? "Resume" : "Pause"}</Button>
          <Button
            disabled={runsOn === undefined && !modelsFailed}
            onClick={() => setDraft({ title: task.title, prompt: task.prompt, schedule: task.schedule, model: initialModel })}
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
  const { time } = frequency(task.schedule);
  return (
    <li>
      <ListRow
        render={<button type="button" aria-haspopup="dialog" onClick={onOpen} />}
        className={task.paused ? "scheduled-task scheduled-task-paused" : "scheduled-task"}
      >
        <ListRowIcon>
          <CalendarClock size={20} />
        </ListRowIcon>
        <ListRowText className="scheduled-task-text">
          {/* A paused task says so in a pill beside its name, as a Sign-ins row states its link. */}
          <span className="scheduled-task-heading">
            <ListRowTitle className="scheduled-task-title">{task.title}</ListRowTitle>
            {task.paused && <StatusPill>Paused</StatusPill>}
          </span>
          <ListRowDetail className="scheduled-task-detail">{time === undefined ? task.prompt : `${time} · ${task.prompt}`}</ListRowDetail>
        </ListRowText>
      </ListRow>
    </li>
  );
}

/** The Scheduled tab: the account's recurring tasks under their frequency labels, loaded each time it opens. */
export function ScheduledPanel({ chatServiceUrl }: { chatServiceUrl: string }) {
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

  const change = async (id: string, changes: Partial<ScheduledTask>) => {
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
      return;
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
            models={models}
            modelsFailed={modelsError !== null}
            notices={notices}
            onChange={(changes) => change(sheet.task.id, changes)}
            onDelete={() => void remove(sheet.task)}
          />
        </Sheet>
      )}
    </div>
  );
}
