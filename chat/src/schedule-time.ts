import { Cron } from 'croner';

export function nextRateTick(schedule: string, createdAt: string, reference: number, startDate?: string): Date | undefined {
  const rate = /^rate\(\s*([1-9]\d*)\s+(minute|hour|day)s?\s*\)$/.exec(schedule);
  if (rate === null) return undefined;
  const units = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  const period = Number(rate[1]) * units[rate[2] as keyof typeof units];
  const anchor = Date.parse(startDate ?? createdAt);
  const lower = Math.max(reference, startDate === undefined ? -Infinity : Date.parse(startDate) - 1);
  return new Date(anchor + Math.max(startDate === undefined ? 1 : 0, Math.floor((lower - anchor) / period) + 1) * period);
}

export function nextScheduledRun({ schedule, timezone, createdAt, startDate }: { schedule: string; timezone: string; createdAt: string; startDate?: string }, after: Date): Date | undefined {
  let reference = after.getTime();
  reference = Math.max(reference, startDate === undefined ? -Infinity : Date.parse(startDate) - 1);
  const cron = /^cron\((.+)\)$/.exec(schedule)?.[1];
  if (cron !== undefined) {
    const fields = cron.trim().split(/\s+/).map((field, index) =>
      // Croner counts the days of the week from 0, Sunday; a lone L is the week's last day, Saturday (7).
      index === 4 ? (field === 'L' ? '7' : field).replace(/(?<![#/\d])\d/g, (number) => String(Number(number) - 1))
        // Croner steps a year's `*` from year 0, which it refuses; EventBridge's years start at 1970.
        : index === 5 ? field.replace(/^\*\//, '1970/') : field);
    if (fields.length !== 6) throw new Error(`Scheduled task cron ${schedule} does not have six fields`);
    // Sloppy ranges read EventBridge's steps from a number (`1/10`), which croner's strict parser refuses.
    const parsed = new Cron(['0', ...fields.map((field) => (field === '?' ? '*' : field))].join(' '), { timezone, sloppyRanges: true });
    let next = parsed.nextRun(new Date(reference));
    // Scheduler skips nonexistent local times. Croner shifts them into the DST gap's next hour.
    while (next !== null && !parsed.match(next)) next = parsed.nextRun(next);
    return next ?? undefined;
  }
  const at = /^at\((.+)\)$/.exec(schedule)?.[1];
  if (at !== undefined) return new Cron(at, { timezone }).nextRun(new Date(reference)) ?? undefined;
  const tick = nextRateTick(schedule, createdAt, reference, startDate);
  if (tick === undefined) throw new Error(`Scheduled task schedule ${schedule} is not cron(...), rate(...) or at(...)`);
  return tick;
}

export function isScheduledInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) return false;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return !Number.isNaN(calendar.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10);
}
