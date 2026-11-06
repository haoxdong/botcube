import type { AgentModel } from "./conversations";
import { pickerModels } from "./picker-models";
import { WEEKDAYS, describeSchedule, fromExpression, lastRun, repeatsWords, stopInstant, toExpression, wallTime, type Cadence, type Ending, type Weekday } from "./schedule";
import type { ScheduledTask, TaskChanges } from "./scheduled-task";

type Counted = Extract<Ending, { kind: "after" }>;

export function afterRuns(maxRuns: number, runsMade: number, cadence: Cadence | null, first: number | undefined, timezone: string): Counted {
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

function weekdayOf(wall: string): Weekday | undefined {
  return WEEKDAYS[new Date(`${wall.slice(0, 10)}T00:00:00Z`).getUTCDay()];
}

/**
 * Repeat's choices, after Codex's Schedule a task: every N minutes (Interval), daily, on weekdays or weekly at a time,
 * once, or the task's own schedule where none of these says it (Custom).
 */
export type Frequency = "interval" | "daily" | "weekdays" | "weekly" | "once" | "custom";

/** The task's own schedule where Repeat can't say it otherwise: its cadence, null where none says it, and its expression in words. */
interface Own {
  cadence: Cadence | null;
  words: string;
}

/** What Repeat holds: how often; Interval's count of minutes, as typed; Weekly's day; and the task's own schedule. */
export interface Repeat {
  frequency: Frequency;
  every: string;
  day: Weekday;
  own: Own | null;
}

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

function ownCadence(own: Own | null, starts: string): Cadence | null {
  const cadence = own?.cadence ?? null;
  return cadence !== null && "time" in cadence && cadence.frequency !== "once" ? { ...cadence, time: starts.slice(11) } : cadence;
}

export function ownWords(own: Own | null, starts: string): string {
  if (own === null) throw new Error("Custom has no schedule of its own");
  const cadence = ownCadence(own, starts);
  return cadence === null ? own.words : repeatsWords(cadence);
}

export function pickedSchedule(repeat: Repeat, starts: string, timezone: string): { cadence: Cadence | null; expression: string | null; start: string } | { why: string } {
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

/**
 * How a task ends as Ends shows it: Never, or its date and time in the task's time zone. A task made with a count of
 * runs ends at the last of them, which follows Starts and Repeat, until another date is picked.
 */
export interface Ends {
  choice: "never" | "on";
  on: string;
  /** The task's count of runs while its end is the last of them; null once a date is picked. */
  count: number | null;
}

function stopOf(ending: Ending): string | null | undefined {
  switch (ending.kind) {
    case "never":
      return null;
    case "on":
      return new Date(ending.at).toISOString();
    case "after":
      // Scheduler may not fire at the last tick if it is also the stop time.
      return undefined;
  }
}

export interface Draft {
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

function startsOf(task: ScheduledTask, cadence: Cadence | null, now: number): string {
  if (cadence?.frequency === "once") return `${cadence.date}T${cadence.time}`;
  const wall = wallTime(task.startDate ?? task.nextRun ?? now, task.timezone);
  return cadence !== null && "time" in cadence ? `${wall.slice(0, 10)}T${cadence.time}` : wall;
}

export function draftOf(task: ScheduledTask, model: string): Draft {
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

export function endingOf(draft: Draft, task: ScheduledTask, cadence: Cadence | null, start: number): Ending {
  const { ends } = draft;
  if (cadence?.frequency === "once" || ends.choice === "never") return { kind: "never" };
  if (ends.count === null) return { kind: "on", at: Date.parse(stopInstant(ends.on, task.timezone)) };
  const counted = countedEnding(task, ends.count, cadence, start, task.timezone);
  return ends.on && counted.last !== undefined ? { ...counted, last: Math.min(counted.last, Date.parse(stopInstant(ends.on, task.timezone))) } : counted;
}

export function edited(draft: Draft, task: ScheduledTask, model: string): { changes: TaskChanges; ending: Ending } | { why: string } {
  const schedule = editedSchedule(draft, task);
  if ("why" in schedule) return schedule;
  const ending = endingOf(draft, task, schedule.cadence, schedule.start);
  if (ending.kind === "on" && wallTime(ending.at, task.timezone) !== draft.ends.on) {
    return { why: "Ends needs a date and time that exists in the task's time zone" };
  }

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

export function modelChoices(task: ScheduledTask, models: AgentModel[] | null, modelsFailed: boolean, runsOn: string | undefined, families?: readonly string[]): ModelChoice[] {
  const choices: ModelChoice[] = [];
  if (models === null || (modelsFailed && runsOn === undefined)) choices.push({ value: runsOn ?? "", label: `${task.model ?? "Account default"} (models unavailable)` });
  // A named model the account no longer has: its runs fail, so it shows as unavailable.
  if (task.model !== undefined && models !== null && !models.some(({ key }) => key === task.model)) {
    choices.push({ value: task.model, label: `${task.model} (${modelsFailed ? "models unavailable" : "unavailable"})`, disabled: true });
  }
  const visible = pickerModels(models ?? [], families);
  const current = models?.find(({ key }) => key === runsOn);
  if (current && !visible.includes(current)) choices.push({ value: current.key, label: current.label, disabled: true });
  return [...choices, ...visible.map(({ key, label }) => ({ value: key, label }))];
}

export function countedWall(ending: Ending | undefined, timezone: string): string | undefined {
  return ending?.kind === "after" && ending.last !== undefined ? wallTime(ending.last, timezone) : undefined;
}
