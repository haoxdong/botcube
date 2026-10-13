import cronstrue from "cronstrue";

/** EventBridge's days of the week, in its order: numbered from 1, Sunday. */
export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * When a task runs, as the agent proposes it and the Edit form shows it: every N minutes or hours, at a time of day
 * (HH:MM, 24-hour) daily, on weekdays, or weekly on chosen days, or once on a date (YYYY-MM-DD) at a time.
 */
export type Cadence =
  | { frequency: "minutes"; every: number }
  | { frequency: "hours"; every: number }
  | { frequency: "daily"; time: string }
  | { frequency: "weekdays"; time: string }
  | { frequency: "weekly"; time: string; days: Weekday[] }
  | { frequency: "once"; date: string; time: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Scheduler's one-off expression: a date and time in the schedule's time zone. */
const AT = /^at\((\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}\)$/;

/** The fields each proposal frequency takes. */
const FIELDS: Record<Cadence["frequency"], string[]> = {
  minutes: ["every", "starts", "ends"],
  hours: ["every", "starts", "ends"],
  daily: ["time", "starts", "ends"],
  weekdays: ["time", "starts", "ends"],
  weekly: ["time", "days", "starts", "ends"],
  once: ["date", "time"],
};

/**
 * The Scheduler expression a cadence runs on. A cadence missing what its frequency needs, or carrying a field it
 * doesn't take, throws, saying what: the Harness refuses such a proposal, so it never schedules.
 */
export function toExpression(cadence: Cadence): string {
  // A field sent as null is unused, as the Harness reads it.
  const sent = cadence as Record<string, unknown>;
  const extra = ["every", "time", "days", "date", "starts", "ends"].find((field) => sent[field] != null && !FIELDS[cadence.frequency].includes(field));
  if (extra !== undefined) throw new Error(`${extra} is not allowed for ${cadence.frequency}`);
  if (cadence.frequency === "minutes" || cadence.frequency === "hours") {
    const { every, frequency } = cadence;
    const unit = frequency.slice(0, -1);
    if (!Number.isInteger(every) || every < 1) throw new Error(`every ${unit} needs a whole number from 1`);
    return `rate(${every} ${every === 1 ? unit : frequency})`;
  }
  const [, hour, minute] = TIME.exec(cadence.time) ?? [];
  if (hour === undefined || minute === undefined) throw new Error(`a ${cadence.frequency} task needs a time as HH:MM`);
  if (cadence.frequency === "once") {
    if (typeof cadence.date !== "string" || !DATE.test(cadence.date)) throw new Error("a once task needs a date as YYYY-MM-DD");
    return `at(${cadence.date}T${cadence.time}:00)`;
  }
  const at = `${Number(minute)} ${Number(hour)}`;
  switch (cadence.frequency) {
    case "daily":
      return `cron(${at} * * ? *)`;
    case "weekdays":
      return `cron(${at} ? * MON-FRI *)`;
    case "weekly": {
      const { days } = cadence;
      // A proposal is the agent's tool call, so its days may be missing or misnamed whatever its type says.
      if (!Array.isArray(days) || days.length === 0 || !days.every((day) => WEEKDAYS.includes(day))) {
        throw new Error("a weekly task needs its days");
      }
      return `cron(${at} ? * ${WEEKDAYS.filter((day) => days.includes(day)).join(",")} *)`;
    }
  }
}

/**
 * The cadence an expression runs on, or null where none says it. `rate(1 day)` is null: it runs every 24 hours, so a
 * daylight-saving change moves its time of day, as a daily cron's doesn't.
 */
export function fromExpression(expression: string): Cadence | null {
  const [, date, at] = AT.exec(expression) ?? [];
  if (date !== undefined && at !== undefined && DATE.test(date) && TIME.test(at)) return { frequency: "once", date, time: at };
  const [, every, unit] = /^rate\(([1-9]\d*) (minute|hour)s?\)$/.exec(expression) ?? [];
  if (every !== undefined) return { frequency: unit === "minute" ? "minutes" : "hours", every: Number(every) };
  const [, minute, hour, days] = /^cron\((\d{1,2}) (\d{1,2}) (\* \* \? \*|\? \* \S+ \*)\)$/.exec(expression) ?? [];
  if (minute === undefined || hour === undefined || days === undefined || Number(minute) > 59 || Number(hour) > 23) return null;
  const runsAt = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  // Every day of the month, or every day of the week.
  if (days === "* * ? *" || days === "? * * *") return { frequency: "daily", time: runsAt };
  const list = days.slice(4, -2);
  if (list === "MON-FRI") return { frequency: "weekdays", time: runsAt };
  // A day is EventBridge's name for it or its number.
  const named = list.split(",").map((day) => WEEKDAYS.find((name, index) => day === name || day === String(index + 1)));
  if (named.some((day) => day === undefined)) return null;
  return { frequency: "weekly", time: runsAt, days: WEEKDAYS.filter((day) => named.includes(day)) };
}

/** The schedule in words; an expression neither `cron(...)` nor `rate(...)` reads as written. */
export function describeSchedule(expression: string): string {
  const cron = /^cron\((.+)\)$/.exec(expression)?.[1];
  if (cron !== undefined) {
    try {
      // EventBridge numbers the days of the week from 1, Sunday. Times read as Activity's do: 7:00 AM, not 07:00 AM.
      return cronstrue.toString(cron, { dayOfWeekStartIndexZero: false, trimHoursLeadingZero: true });
    } catch {
      return expression;
    }
  }
  const [, count, unit] = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(expression) ?? [];
  if (count === undefined || unit === undefined) return expression;
  // A day's rate runs every 24 hours whatever the clock says, unlike Daily at a time of day.
  if (count === "1" && unit === "day") return "Every 24 hours";
  return count === "1" ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** 7:00 AM, as the Scheduled list, Activity and the Edit form's Time show times. */
export function clock(time: string): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** A day of the week's name: Monday. A day that isn't one throws, saying so. */
export function dayName(day: Weekday): string {
  const name = DAY_NAMES[WEEKDAYS.indexOf(day)];
  if (name === undefined) throw new Error(`${day} is not a day of the week`);
  return name;
}

/** Days of the week in words: Monday, or Monday and Thursday. */
function dayList(days: Weekday[]): string {
  return new Intl.ListFormat("en-US").format(days.map(dayName));
}

/** How often a cadence repeats, in the Edit form's Repeat words: Every 5 minutes, Daily, Weekdays, Weekly on Monday, Once. */
function repeatsOption(cadence: Cadence): string {
  switch (cadence.frequency) {
    case "minutes":
    case "hours":
      return describeSchedule(toExpression(cadence));
    case "daily":
      return "Daily";
    case "weekdays":
      return "Weekdays";
    case "weekly":
      return `Weekly on ${dayList(cadence.days)}`;
    case "once":
      return "Once";
  }
}

/**
 * The label the Scheduled tab lists an expression under, in Repeat's words, and its time of day where it has one; a
 * one-off lists under Once, with its date. An expression none of them says lists under its own words.
 */
export function listing(expression: string): { label: string; time?: string } {
  const cadence = fromExpression(expression);
  if (cadence === null) return { label: describeSchedule(expression) };
  if (cadence.frequency === "once") {
    const day = new Date(`${cadence.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return { label: "Once", time: `${day}, ${clock(cadence.time)}` };
  }
  return "time" in cadence ? { label: repeatsOption(cadence), time: clock(cadence.time) } : { label: repeatsOption(cadence) };
}

/** Each time zone's clock, made once: counting runs reads it for every day it steps. */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** An instant as the Edit form's Starts and Ends hold it: the date and time (YYYY-MM-DDTHH:MM) in a time zone. */
export function wallTime(instant: string | number, timezone: string): string {
  let format = clocks.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    clocks.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const WALL_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The instant (ISO) a date and time (YYYY-MM-DDTHH:MM) names in a time zone: Scheduler's `StartDate` or `EndDate`.
 * A wall time that isn't one throws, saying so.
 */
export function stopInstant(wall: string, timezone: string): string {
  if (!WALL_TIME.test(wall) || Number.isNaN(Date.parse(`${wall}:00Z`))) throw new Error("a stop time needs a date and time as YYYY-MM-DDTHH:MM");
  const asUtc = Date.parse(`${wall}:00Z`);
  // The zone's offset at that moment, read back from the clock it shows; read again at the first guess, since the
  // offset can differ there when a daylight-saving change falls between the two.
  const offset = (at: number) => Date.parse(`${wallTime(at, timezone)}:00Z`) - at;
  const first = asUtc - offset(asUtc);
  return new Date(asUtc - offset(first)).toISOString();
}

/**
 * How often a cadence repeats, as a task's sheet and a proposal say it: Repeat's words, then the time of day it runs
 * at where it has one, as Weekly on Monday and Wednesday at 7:00 AM.
 */
export function repeatsWords(cadence: Cadence): string {
  return cadence.frequency === "once" || !("time" in cadence) ? repeatsOption(cadence) : `${repeatsOption(cadence)} at ${clock(cadence.time)}`;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The first `count` runs of a cadence at or after `first`, as instants: a rate's every period from `first`; a daily,
 * weekdays or weekly task's time of day, in its time zone, on each day it runs; a one-off's time.
 */
export function runs(cadence: Cadence, first: number, count: number, timezone: string): number[] {
  if (cadence.frequency === "minutes" || cadence.frequency === "hours") {
    const period = cadence.every * (cadence.frequency === "minutes" ? MINUTE : 60 * MINUTE);
    return Array.from({ length: count }, (_, index) => first + index * period);
  }
  if (cadence.frequency === "once") return [Date.parse(stopInstant(`${cadence.date}T${cadence.time}`, timezone))];
  const days: readonly Weekday[] = cadence.frequency === "daily" ? WEEKDAYS : cadence.frequency === "weekdays" ? WEEKDAYS.slice(1, 6) : cadence.days;
  const found: number[] = [];
  let midnight = Date.parse(`${wallTime(first, timezone).slice(0, 10)}T00:00:00Z`);
  // A task with a day to run on runs within any 7 days.
  for (let step = 0; found.length < count && step < 7 * (count + 1); step += 1, midnight += DAY) {
    const run = Date.parse(stopInstant(`${new Date(midnight).toISOString().slice(0, 10)}T${cadence.time}`, timezone));
    if (days.includes(WEEKDAYS[new Date(midnight).getUTCDay()] ?? "SUN") && run >= first) found.push(run);
  }
  return found;
}

export function lastRun(cadence: Cadence, first: number, count: number, timezone: string): number | undefined {
  if (count < 1) return undefined;
  if (cadence.frequency === "minutes" || cadence.frequency === "hours") {
    const period = cadence.every * (cadence.frequency === "minutes" ? MINUTE : 60 * MINUTE);
    const last = first + (count - 1) * period;
    const year = new Date(last).getUTCFullYear();
    return year >= 0 && year <= 9999 ? last : undefined;
  }
  if (cadence.frequency === "once") return runs(cadence, first, 1, timezone)[0];
  const days = cadence.frequency === "daily" ? WEEKDAYS : cadence.frequency === "weekdays" ? WEEKDAYS.slice(1, 6) : WEEKDAYS.filter((day) => cadence.days.includes(day));
  if (days.length === 0) return undefined;
  const week = runs(cadence, first, days.length, timezone);
  const inWeek = week[(count - 1) % days.length];
  if (inWeek === undefined) return undefined;
  const date = new Date(Date.parse(`${wallTime(inWeek, timezone).slice(0, 10)}T00:00:00Z`) + Math.floor((count - 1) / days.length) * 7 * DAY);
  const year = date.getUTCFullYear();
  if (!(year >= 0 && year <= 9999)) return undefined;
  return Date.parse(stopInstant(`${date.toISOString().slice(0, 10)}T${cadence.time}`, timezone));
}

/** A time zone's short name at an instant: ET or PT where it has one, else its offset (GMT+1) or UTC. */
export function zoneName(timezone: string, at: number): string {
  const name = (timeZoneName: "shortGeneric" | "short") =>
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName }).formatToParts(at).find(({ type }) => type === "timeZoneName")?.value ?? timezone;
  const generic = name("shortGeneric");
  return generic.length <= 4 ? generic : name("short");
}

/** An instant as a task's sheet says its runs, in its time zone: Mon, Oct 12, 3:02 PM. */
export function dayTime(instant: string | number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(instant));
}

/** How a task stops: never, at an instant, or after a count of runs, the last of them at an instant where known. */
export type Ending = { kind: "never" } | { kind: "on"; at: number } | { kind: "after"; runs: number; last?: number | undefined };

/** "minute" or "minutes", by the count before it. */
export function unitOf(unit: string, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

/** A date (YYYY-MM-DD) as a summary says it: Oct 14, with its year when that isn't today's. */
function shortDate(date: string, today: string): string {
  const year = date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" as const };
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...year, timeZone: "UTC" });
}

/** An instant's time in a time zone, after its date when that isn't today there: 3:02 PM, Oct 14, 9:00 AM. */
function dateTime(at: number, timezone: string, now: number): string {
  const [wall, today] = [wallTime(at, timezone), wallTime(now, timezone)];
  return `${wall.slice(0, 10) === today.slice(0, 10) ? "" : `${shortDate(wall.slice(0, 10), today)}, `}${clock(wall.slice(11))}`;
}

/**
 * A date and time (YYYY-MM-DDTHH:MM) in words, as the Edit form's rows show it: Tue, Oct 6, 3:02 PM ET. A wall time
 * that isn't one throws, saying so.
 */
export function wallWords(wall: string, timezone: string): string {
  const at = Date.parse(stopInstant(wall, timezone));
  return `${dayTime(at, timezone)} ${zoneName(timezone, at)}`;
}

/**
 * A task's schedule in one plain line, as a proposal says it: how it repeats, from when, how it ends,
 * and the time zone. A time carries its date only when it isn't today there: "Every minute from 3:02 PM, ends
 * 3:04 PM ET", "Weekdays at 7:00 AM from Oct 14 ET", "Once on Oct 14, 9:00 AM ET".
 */
export function summary(schedule: string, timezone: string, start: number | undefined, ending: Ending, now = Date.now(), starts?: number): string {
  const date = (at: number) => wallTime(at, timezone).slice(0, 10);
  const today = (at: number) => date(at) === date(now);
  const day = (at: number) => shortDate(date(at), date(now));
  const when = (at: number) => dateTime(at, timezone, now);
  const cadence = fromExpression(schedule);
  if (cadence?.frequency === "once") {
    const [run = now] = runs(cadence, now, 1, timezone);
    return `Once ${today(run) ? "at" : "on"} ${when(run)} ${zoneName(timezone, run)}`;
  }
  let words = cadence === null ? describeSchedule(schedule) : repeatsWords(cadence);
  // A daily, weekdays or weekly task's words carry its time of day already, and its start date only when it waits past its next run day.
  const calendar = cadence !== null && "time" in cadence ? cadence : null;
  const [next] = calendar === null ? [] : runs(calendar, now, 1, timezone);
  if (starts !== undefined) words += `, starts ${when(starts)}`;
  else if (start !== undefined && !(next !== undefined && date(start) <= date(next))) words += ` from ${calendar ? day(start) : when(start)}`;
  words += endingWords(ending, when);
  return `${words} ${zoneName(timezone, starts ?? start ?? now)}`;
}

function endingWords(ending: Ending, when: (at: number) => string): string {
  switch (ending.kind) {
    case "on":
      return `, ends ${when(ending.at)}`;
    case "after":
      // A count reads as its last run, its count only where that can't be said.
      return ending.last === undefined ? `, ${ending.runs} ${unitOf("run", ending.runs)}` : `, ends ${when(ending.last)}`;
  }
  return "";
}
