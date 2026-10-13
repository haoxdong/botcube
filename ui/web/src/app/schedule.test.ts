// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { dayTime, describeSchedule, fromExpression, lastRun, listing, repeatsWords, runs, summary, zoneName, type Cadence } from './schedule';

const NY = 'America/New_York';
const at = (iso: string) => Date.parse(iso);
const iso = (instants: number[]) => instants.map((instant) => new Date(instant).toISOString());

describe('runs', () => {
  it('steps a rate from its first run', () => {
    expect(iso(runs({ frequency: 'minutes', every: 1 }, at('2026-10-06T19:02:00Z'), 3, NY))).toEqual([
      '2026-10-06T19:02:00.000Z', '2026-10-06T19:03:00.000Z', '2026-10-06T19:04:00.000Z',
    ]);
    expect(iso(runs({ frequency: 'hours', every: 2 }, at('2026-10-06T19:00:00Z'), 2, NY))).toEqual([
      '2026-10-06T19:00:00.000Z', '2026-10-06T21:00:00.000Z',
    ]);
  });

  it('runs a daily task from the first of its times at or after the start, across a clock change', () => {
    // 7:00 AM New York on 31 October has passed at 9:00; 1 November turns the clocks back.
    expect(iso(runs({ frequency: 'daily', time: '07:00' }, at('2026-10-30T13:00:00Z'), 3, NY))).toEqual([
      '2026-10-31T11:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z',
    ]);
  });

  it('skips the days a weekdays or weekly task does not run on', () => {
    // 9 October 2026 is a Friday.
    expect(iso(runs({ frequency: 'weekdays', time: '08:00' }, at('2026-10-09T12:00:00Z'), 3, NY))).toEqual([
      '2026-10-09T12:00:00.000Z', '2026-10-12T12:00:00.000Z', '2026-10-13T12:00:00.000Z',
    ]);
    expect(iso(runs({ frequency: 'weekly', time: '08:00', days: ['MON', 'FRI'] }, at('2026-10-09T12:00:01Z'), 2, NY))).toEqual([
      '2026-10-12T12:00:00.000Z', '2026-10-16T12:00:00.000Z',
    ]);
  });

  it('finds no run for a weekly task with no days', () => {
    expect(runs({ frequency: 'weekly', time: '08:00', days: [] }, at('2026-10-09T12:00:00Z'), 2, NY)).toEqual([]);
  });
});

describe('lastRun', () => {
  it.each([
    [{ frequency: 'daily', time: '07:00' }, '2026-10-30T13:00:00Z', 3, '2026-11-02T12:00:00.000Z'],
    [{ frequency: 'weekdays', time: '08:00' }, '2026-10-09T12:00:00Z', 3, '2026-10-13T12:00:00.000Z'],
    [{ frequency: 'weekly', time: '08:00', days: ['MON', 'FRI', 'MON'] }, '2026-10-09T12:00:01Z', 2, '2026-10-16T12:00:00.000Z'],
    [{ frequency: 'weekly', time: '08:00', days: ['MON', 'FRI'] }, '2026-10-09T12:00:01Z', 8, '2026-11-06T13:00:00.000Z'],
    [{ frequency: 'once', date: '2026-11-06', time: '08:00' }, '2026-10-09T12:00:00Z', 1, '2026-11-06T13:00:00.000Z'],
  ] as const)('finds the final occurrence for %j across weekends and clock changes', (cadence, first, count, expected) => {
    expect(lastRun(cadence as Cadence, at(first), count, NY)).toBe(at(expected));
  });

  it('computes a billion rate occurrences without expanding them', () => {
    expect(lastRun({ frequency: 'minutes', every: 1 }, at('2026-10-06T19:02:00Z'), 1_000_000_000, NY)).toBe(at('3928-02-03T05:41:00.000Z'));
  });

  it.each([
    { frequency: 'daily', time: '08:00' },
    { frequency: 'hours', every: 1 },
    { frequency: 'weekly', time: '08:00', days: ['MON'] },
  ] as Cadence[])('leaves an unrepresentable final date unknown for %j', (cadence) => {
    expect(lastRun(cadence, at('2026-10-06T19:02:00Z'), 1_000_000_000, NY)).toBeUndefined();
  });

  it('finds no remaining occurrence for an exhausted count or a weekly task without days', () => {
    expect(lastRun({ frequency: 'minutes', every: 1 }, at('2026-10-06T19:02:00Z'), 0, NY)).toBeUndefined();
    expect(lastRun({ frequency: 'weekly', time: '08:00', days: [] }, at('2026-10-06T19:02:00Z'), 3, NY)).toBeUndefined();
  });
});

describe('zoneName', () => {
  it('names a zone by its short generic name when that is short, else by its offset', () => {
    const october = at('2026-10-06T19:02:00Z');
    expect([NY, 'America/Los_Angeles', 'Europe/London', 'UTC'].map((zone) => zoneName(zone, october))).toEqual(['ET', 'PT', 'GMT+1', 'UTC']);
  });
});

describe('fromExpression', () => {
  // cron(M H ? * * *) is daily too.
  it.each<[string, Cadence | null]>([
    ['cron(30 7 ? * * *)', { frequency: 'daily', time: '07:30' }],
    ['cron(30 7 * * ? *)', { frequency: 'daily', time: '07:30' }],
    ['rate(3 days)', null],
    ['cron(0 8 1 * ? *)', null],
  ])('reads %s as %j', (expression, cadence) => {
    expect(fromExpression(expression)).toEqual(cadence);
  });

  it('reads rate(1 day) as no daily cadence: it runs every 24 hours, so a clock change moves its time of day', () => {
    expect(fromExpression('rate(1 day)')).toBeNull();
    expect(describeSchedule('rate(1 day)')).toBe('Every 24 hours');
    expect(describeSchedule('rate(3 days)')).toBe('Every 3 days');
  });
});

describe('listing', () => {
  it.each<[string, { label: string; time?: string }]>([
    ['rate(1 day)', { label: 'Every 24 hours' }],
    ['cron(0 7 ? * * *)', { label: 'Daily', time: '7:00 AM' }],
    ['cron(0 7 ? * MON-FRI *)', { label: 'Weekdays', time: '7:00 AM' }],
    ['cron(0 7 ? * TUE *)', { label: 'Weekly on Tuesday', time: '7:00 AM' }],
    ['rate(5 minutes)', { label: 'Every 5 minutes' }],
    ['at(2026-10-14T08:30:00)', { label: 'Once', time: 'Oct 14, 8:30 AM' }],
    ['cron(0 8 1 * ? *)', { label: 'At 8:00 AM, on day 1 of the month' }],
  ])('lists %s in Repeat\'s words', (expression, listed) => {
    expect(listing(expression)).toEqual(listed);
  });
});

describe('repeatsWords', () => {
  it.each<[Cadence, string]>([
    [{ frequency: 'minutes', every: 1 }, 'Every minute'],
    [{ frequency: 'minutes', every: 5 }, 'Every 5 minutes'],
    [{ frequency: 'hours', every: 1 }, 'Every hour'],
    [{ frequency: 'hours', every: 3 }, 'Every 3 hours'],
    [{ frequency: 'daily', time: '07:00' }, 'Daily at 7:00 AM'],
    [{ frequency: 'weekdays', time: '19:30' }, 'Weekdays at 7:30 PM'],
    [{ frequency: 'weekly', time: '07:00', days: ['MON', 'WED', 'FRI'] }, 'Weekly on Monday, Wednesday, and Friday at 7:00 AM'],
    [{ frequency: 'once', date: '2026-10-14', time: '09:00' }, 'Once'],
  ])('says %j as %s', (cadence, words) => {
    expect(repeatsWords(cadence)).toBe(words);
  });
});

describe('dayTime', () => {
  it('says an instant as its day, date and time in a time zone', () => {
    expect(dayTime('2026-10-12T19:02:00Z', NY)).toBe('Mon, Oct 12, 3:02 PM');
  });
});

describe('summary', () => {
  // 1:00 AM New York on 6 October.
  const now = at('2026-10-06T05:00:00Z');

  it("says the issue's every-minute task that stops after 3 runs at its last run", () => {
    const start = at('2026-10-06T19:02:00Z');
    expect(summary('rate(1 minute)', NY, start, { kind: 'after', runs: 3, last: at('2026-10-06T19:04:00Z') }, now))
      .toBe('Every minute from 3:02 PM, ends 3:04 PM ET');
  });

  it('dates a time that is not today', () => {
    expect(summary('rate(5 minutes)', NY, at('2026-10-14T13:00:00Z'), { kind: 'on', at: at('2026-10-15T21:00:00Z') }, now))
      .toBe('Every 5 minutes from Oct 14, 9:00 AM, ends Oct 15, 5:00 PM ET');
    expect(summary('rate(1 hour)', NY, at('2026-10-06T19:00:00Z'), { kind: 'after', runs: 1, last: at('2026-10-06T19:00:00Z') }, now))
      .toBe('Every hour from 3:00 PM, ends 3:00 PM ET');
  });

  it('says the time of day once for a daily, weekdays or weekly task, and its start date when it waits past its next run day', () => {
    expect(summary('cron(0 7 * * ? *)', NY, at('2026-10-06T11:00:00Z'), { kind: 'never' }, now)).toBe('Daily at 7:00 AM ET');
    expect(summary('cron(0 7 ? * MON-FRI *)', NY, at('2026-10-14T11:00:00Z'), { kind: 'never' }, now)).toBe('Weekdays at 7:00 AM from Oct 14 ET');
    // 6 October 2026 is a Tuesday, so a Monday and Thursday task first runs on Thursday 8 October anyway.
    expect(summary('cron(5 7 ? * MON,THU *)', NY, at('2026-10-08T11:05:00Z'), { kind: 'never' }, now)).toBe('Weekly on Monday and Thursday at 7:05 AM ET');
  });

  it('says a one-off run as its date and time, or its time today', () => {
    expect(summary('at(2026-10-14T09:00:00)', NY, undefined, { kind: 'never' }, now)).toBe('Once on Oct 14, 9:00 AM ET');
    expect(summary('at(2026-10-06T09:00:00)', NY, undefined, { kind: 'never' }, now)).toBe('Once at 9:00 AM ET');
    expect(summary('at(2020-01-02T08:30:00)', 'UTC', undefined, { kind: 'never' }, now)).toBe('Once on Jan 2, 2020, 8:30 AM UTC');
  });

  it('says a count of runs whose last it cannot place, and a schedule the Edit form cannot show in its own words', () => {
    expect(summary('rate(1 minute)', NY, undefined, { kind: 'after', runs: 3 }, now)).toBe('Every minute, 3 runs ET');
    expect(summary('cron(0 8 1 * ? *)', 'UTC', undefined, { kind: 'never' }, now)).toBe('At 8:00 AM, on day 1 of the month UTC');
  });
});
