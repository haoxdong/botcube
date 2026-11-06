import { describe, expect, it } from 'vitest';
import { nextScheduledRun } from './schedule-time.js';

const schedule = { schedule: 'rate(1 hour)', timezone: 'UTC', createdAt: '2026-10-01T09:17:30.000Z' };

describe('scheduled occurrences', () => {
  it('preserves the creation phase when no explicit start is set', () => {
    expect(nextScheduledRun(schedule, new Date('2026-10-01T10:30:00.000Z'))?.toISOString()).toBe('2026-10-01T11:17:30.000Z');
  });

  it('uses explicit Starts as the first rate occurrence and preserves that phase', () => {
    const started = { ...schedule, startDate: '2026-10-02T11:42:00.000Z' };
    expect(nextScheduledRun(started, new Date('2026-10-01T10:30:00.000Z'))?.toISOString()).toBe('2026-10-02T11:42:00.000Z');
    expect(nextScheduledRun(started, new Date('2026-10-02T11:42:00.000Z'))?.toISOString()).toBe('2026-10-02T12:42:00.000Z');
  });

  it('includes a cron occurrence exactly at Starts', () => {
    expect(nextScheduledRun({ ...schedule, schedule: 'cron(0 12 * * ? *)', startDate: '2026-10-02T12:00:00.000Z' }, new Date('2026-10-01T10:30:00.000Z'))?.toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });

  it('skips a nonexistent spring local time like EventBridge Scheduler', () => {
    expect(nextScheduledRun({ ...schedule, schedule: 'cron(30 2 * * ? *)', timezone: 'America/New_York' }, new Date('2026-03-07T08:00:00.000Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('runs an autumn repeated local time once', () => {
    const fall = { ...schedule, schedule: 'cron(30 1 * * ? *)', timezone: 'America/New_York' };
    const first = nextScheduledRun(fall, new Date('2026-10-31T08:00:00.000Z'));
    expect(first?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    if (first === undefined) throw new Error('Expected the first autumn occurrence');
    expect(nextScheduledRun(fall, first)?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
});
