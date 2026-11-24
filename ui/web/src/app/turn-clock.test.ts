import { beforeEach, describe, expect, it, vi } from 'vitest';
import { turnClock, type TurnTime } from './turn-clock';
import type { WorklogClock } from './worklog-clock';

const START = Date.parse('2026-10-11T14:05:41Z');
const at = (seconds: number) => START + seconds * 1000;
/** When a message started and ended, `from` and `to` seconds into its Turn. */
const stamp = (from: number, to: number) => ({ metadata: { started_at: at(from), ended_at: at(to) } });
const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'execute', arguments: '{}' } });
const sum = ({ steps }: TurnTime) => steps.reduce((total, step) => total + step.seconds, 0);
const times = ({ steps }: TurnTime) => Object.fromEntries(steps.map((step) => [step.kind, step.seconds]));

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe('a Turn clock', () => {
  it('times a Turn loaded from history by its stamps, its steps summing to its total, and stands still', () => {
    const question = { id: 'history-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const turn = [
      { id: 'history-a', role: 'assistant', content: '', toolCalls: [call('history-c')], ...stamp(0, 1.5) },
      { id: 'history-t', role: 'tool', toolCallId: 'history-c', content: 'Done', ...stamp(1, 2.3) },
      { id: 'history-f', role: 'assistant', content: '2s10s steepened.', ...stamp(34.4, 38) },
    ];
    const clock = turnClock(question.id, { turn, question, running: false, advanceClock: false });

    const time = clock.at(at(500));
    expect(clock.ticks).toBe(false);
    expect(time).toMatchObject({ total: 38, settled: true });
    expect(times(time)).toEqual({ tool: 2, answer: 36 });
    expect(sum(time)).toBe(38);
    expect(clock.at(at(9000))).toEqual(time);
  });

  it('falls back to the span of its messages when they cannot time each step, and says nothing when unstamped', () => {
    const turn = [
      { id: 'span-a', role: 'assistant', content: '', toolCalls: [call('span-c')], ...stamp(0, 1) },
      { id: 'span-t', role: 'tool', toolCallId: 'span-c', content: 'Done' },
    ];
    expect(turnClock('span-u', { turn, running: false }).at(at(60))).toEqual({ total: 1, steps: [], settled: true });
    expect(turnClock('bare-u', { turn: [{ id: 'bare-a', role: 'assistant', content: '', toolCalls: [call('bare-c')] }, { id: 'bare-t', role: 'tool', toolCallId: 'bare-c', content: 'Done' }], running: false }).at(at(60)).total).toBeUndefined();
  });

  it('keeps a zero-second step at zero and folds a start-up under a second into the first step', () => {
    const question = { id: 'zero-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const turn = [
      { id: 'zero-r', role: 'reasoning', content: '**Plan**', ...stamp(0.4, 3) },
      { id: 'zero-a', role: 'assistant', content: '', toolCalls: [call('zero-c')], ...stamp(3, 3) },
      { id: 'zero-t', role: 'tool', toolCallId: 'zero-c', content: 'Done', ...stamp(3, 3.2) },
      { id: 'zero-f', role: 'assistant', content: 'Done.', ...stamp(3.2, 6) },
    ];
    const time = turnClock(question.id, { turn, question, running: false }).at(at(6));

    expect(time.steps.map((step) => step.kind)).toEqual(['thought', 'tool', 'answer']);
    expect(times(time)).toEqual({ thought: 3, tool: 0, answer: 3 });
    expect(sum(time)).toBe(time.total);
  });

  it('counts a running step up with the wall clock from the Chat Service start while its question is unstamped', () => {
    const question = { id: 'live-u', role: 'user', content: 'Rates' };
    const turn = [{ id: 'live-a', role: 'assistant', content: '', toolCalls: [call('live-c')], ...stamp(0, 0) }];
    const clock = turnClock(question.id, { turn, question, running: true, serverStart: new Date(at(-2)).toISOString() });

    expect(clock.ticks).toBe(true);
    expect(clock.at(at(3))).toMatchObject({ total: 5, settled: false });
    expect(clock.at(at(7)).total).toBe(9);
    expect(sum(clock.at(at(7)))).toBe(9);
  });

  it('keeps the seconds a step showed live when replay stamps it shorter, across a reload', async () => {
    const question = { id: 'replay-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const tool = { id: 'replay-a', role: 'assistant', content: '', toolCalls: [call('replay-c')], ...stamp(0, 0) };
    const live = turnClock(question.id, { turn: [tool], question, running: true }).at(at(5));
    expect(times(live)).toEqual({ tool: 5 });

    const replayed = [tool, { id: 'replay-t', role: 'tool', toolCallId: 'replay-c', content: 'Done', ...stamp(0, 3) }, { id: 'replay-f', role: 'assistant', content: 'Done.', ...stamp(3, 6) }];
    const ended = turnClock(question.id, { turn: replayed, question, running: false }).at(at(6));
    expect(ended).toMatchObject({ total: 6, settled: true });
    expect(times(ended)).toEqual({ tool: 5, answer: 1 });

    vi.resetModules();
    const reloaded = await import('./turn-clock');
    expect(times(reloaded.turnClock(question.id, { turn: replayed, question, running: false }).at(at(6)))).toEqual({ tool: 5, answer: 1 });
  });

  it("moves with the Chat Service's clock rather than the wall clock, and settles at its end once the run ends", () => {
    const question = { id: 'server-u', role: 'user', content: 'Rates' };
    const turn = [{ id: 'server-r', role: 'reasoning', content: '**Plan**' }];
    const clock = (fields: Partial<WorklogClock>): WorklogClock => ({ version: 1, question_id: question.id, started_at: START, steps: { 'server-r': { started_at: START } }, ...fields });
    const running = turnClock(question.id, { turn, question, running: true, serverClock: clock({ at: at(4) }) });

    expect(running.ticks).toBe(false);
    expect(running.at(at(60))).toMatchObject({ total: 4, settled: false });

    const settled = turnClock(question.id, { turn, question, running: false, serverClock: clock({ at: at(9), ended_at: at(9), steps: { 'server-r': { started_at: START, ended_at: at(9) } } }) });
    expect(settled.at(at(60))).toMatchObject({ total: 9, settled: true });
    expect(settled.at(at(600))).toEqual(settled.at(at(60)));
  });

  it("prefers the Chat Service's live clock to the one recorded on the question", () => {
    const recorded: WorklogClock = { version: 1, question_id: 'rank-u', started_at: START, at: at(7), ended_at: at(7), steps: {} };
    const question = { id: 'rank-u', role: 'user', content: 'Rates', metadata: { worklog_clock: recorded } };

    expect(turnClock(question.id, { question, running: false }).at(at(60)).total).toBe(7);
    expect(turnClock(question.id, { question, running: true, serverClock: { ...recorded, at: at(3), ended_at: undefined } }).at(at(60)).total).toBe(3);
  });
});
