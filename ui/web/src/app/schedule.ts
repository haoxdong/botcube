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

/** The fields each frequency takes, as the Harness's proposal tool allows them: a stop time (`ends`) for any but once. */
const FIELDS: Record<Cadence["frequency"], string[]> = {
  minutes: ["every", "ends"],
  hours: ["every", "ends"],
  daily: ["time", "ends"],
  weekdays: ["time", "ends"],
  weekly: ["time", "days", "ends"],
  once: ["date", "time"],
};

/**
 * The Scheduler expression a cadence runs on. A cadence missing what its frequency needs, or carrying a field it
 * doesn't take, throws, saying what: the Harness refuses such a proposal, so it never schedules.
 */
export function toExpression(cadence: Cadence): string {
  // A field sent as null is unused, as the Harness reads it.
  const sent = cadence as Record<string, unknown>;
  const extra = ["every", "time", "days", "date", "ends"].find((field) => sent[field] != null && !FIELDS[cadence.frequency].includes(field));
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

/** The cadence an expression runs on, or null when the Edit form's controls can't show it. */
export function fromExpression(expression: string): Cadence | null {
  const [, date, at] = AT.exec(expression) ?? [];
  if (date !== undefined && at !== undefined && DATE.test(date) && TIME.test(at)) return { frequency: "once", date, time: at };
  const [, every, unit] = /^rate\(([1-9]\d*) (minute|hour)s?\)$/.exec(expression) ?? [];
  if (every !== undefined) return { frequency: unit === "minute" ? "minutes" : "hours", every: Number(every) };
  const [, minute, hour, days] = /^cron\((\d{1,2}) (\d{1,2}) (\* \* \? \*|\? \* \S+ \*)\)$/.exec(expression) ?? [];
  if (minute === undefined || hour === undefined || days === undefined || Number(minute) > 59 || Number(hour) > 23) return null;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (days === "* * ? *") return { frequency: "daily", time };
  const list = days.slice(4, -2);
  if (list === "MON-FRI") return { frequency: "weekdays", time };
  // A day is EventBridge's name for it or its number.
  const named = list.split(",").map((day) => WEEKDAYS.find((name, index) => day === name || day === String(index + 1)));
  if (named.some((day) => day === undefined)) return null;
  return { frequency: "weekly", time, days: WEEKDAYS.filter((day) => named.includes(day)) };
}

/** A date and time in words, as the proposal card and a task's sheet say them: November 6, 2026 at 8:30 AM. */
function dateWords(date: string, time: string): string {
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${day} at ${clock(time)}`;
}

/** The schedule in words; an expression neither `cron(...)`, `rate(...)` nor `at(...)` reads as written. */
export function describeSchedule(expression: string): string {
  const once = fromExpression(expression);
  if (once?.frequency === "once") return `Once on ${dateWords(once.date, once.time)}`;
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
  return count === "1" ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** 7:00 AM, as the Scheduled list and Activity show times. */
function clock(time: string): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * The label the Scheduled tab lists an expression under (Muse Fig 15's "Daily"), as the Edit form's Frequency names
 * it, and its time of day when it has one. An expression the Edit form can't show lists under its own words.
 */
export function listing(expression: string): { label: string; time?: string } {
  const cadence = fromExpression(expression);
  if (cadence === null) return { label: describeSchedule(expression) };
  switch (cadence.frequency) {
    case "minutes":
    case "hours":
      return { label: describeSchedule(expression) };
    case "daily":
      return { label: "Daily", time: clock(cadence.time) };
    case "weekdays":
      return { label: "Weekdays", time: clock(cadence.time) };
    case "weekly":
      return { label: `Every ${cadence.days.map((day) => DAY_NAMES[WEEKDAYS.indexOf(day)]).join(", ")}`, time: clock(cadence.time) };
    case "once": {
      const day = new Date(`${cadence.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      return { label: "Once", time: `${day}, ${clock(cadence.time)}` };
    }
  }
}

/** A stop time as the Edit form's Ends field holds it: the date and time (YYYY-MM-DDTHH:MM) in a time zone. */
export function wallTime(instant: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const WALL_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The instant (ISO) a date and time (YYYY-MM-DDTHH:MM) names in a time zone: Scheduler's `EndDate` for a stop time.
 * A wall time that isn't one throws, saying so.
 */
export function stopInstant(wall: string, timezone: string): string {
  if (!WALL_TIME.test(wall) || Number.isNaN(Date.parse(`${wall}:00Z`))) throw new Error("a stop time needs a date and time as YYYY-MM-DDTHH:MM");
  const asUtc = Date.parse(`${wall}:00Z`);
  // The zone's offset at that moment, read back from the clock it shows; read again at the first guess, since the
  // offset can differ there when a daylight-saving change falls between the two.
  const offset = (at: number) => Date.parse(`${wallTime(new Date(at).toISOString(), timezone)}:00Z`) - at;
  const first = asUtc - offset(asUtc);
  return new Date(asUtc - offset(first)).toISOString();
}

/** A stop time in words, in the task's time zone: "Ends December 31, 2026 at 5:00 PM", or "Ended …" once past. */
export function describeEnd(instant: string, timezone: string, now = Date.now()): string {
  const [date = "", time = ""] = wallTime(instant, timezone).split("T");
  return `${Date.parse(instant) <= now ? "Ended" : "Ends"} ${dateWords(date, time)}`;
}
