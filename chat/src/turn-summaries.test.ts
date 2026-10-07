import { describe, expect, it, vi } from 'vitest';
import type { TurnActivity, TurnSummary } from './session-metadata.js';
import { recordTurnSummary, reportUnsavedTurnSummaries } from './turn-summaries.js';

describe('saving a Turn summary', () => {
  it('propagates a failed storage write with its original cause', async () => {
    const failure = new Error('DynamoDB rejected the summary write');
    const saved = recordTurnSummary(
      async () => ({ title: 'Brief on rates', summary: 'Compared the yields' }),
      async () => { throw failure; },
      'session-storage-error',
      { request: 'Compare rates', answer: 'The curve flattened.' },
    );
    await expect(saved).rejects.toMatchObject({
      message: 'The Turn summary could not be saved: DynamoDB rejected the summary write',
      cause: failure,
    });
  });

  it("saves the request's first line and completion time with the summary", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T01:02:03.004Z') });
    const saved: TurnActivity[] = [];
    await recordTurnSummary(
      async () => ({ title: 'Brief on rates', summary: 'Compared the yields' }),
      async (finished) => { saved.push(finished); },
      'session-1',
      { request: '  Compare rates\nacross the curve', answer: 'The curve flattened.' },
    );
    vi.useRealTimers();
    expect(saved).toEqual([
      { request: 'Compare rates', completedAt: '2026-10-05T01:02:03.004Z', summary: { title: 'Brief on rates', summary: 'Compared the yields' } },
    ]);
  });

  it('saves a Turn the summary model failed on without a summary, failed on why, then propagates the failure', async () => {
    const saved: TurnActivity[] = [];
    const failed = recordTurnSummary(
      async () => { throw new Error('The summary model answered HTTP 500'); },
      async (finished) => { saved.push(finished); },
      'session-1',
      { request: 'Compare rates', answer: 'The curve flattened.' },
    );
    await expect(failed).rejects.toThrow('The Turn summary could not be saved: The summary model answered HTTP 500');
    expect(saved).toEqual([
      { request: 'Compare rates', completedAt: expect.any(String), failed: 'The Turn summary could not be made: The summary model answered HTTP 500' },
    ]);
  });
});

// A summary runs on after its Turn's stream closed, so a stopping task can cut it off.
describe('a stopping Chat Service', () => {
  it('raises the Turn-summary alarm for each summary it has not saved yet', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let summarized: (summary: TurnSummary) => void = () => undefined;
    const saving = recordTurnSummary(
      () => new Promise((resolve) => { summarized = resolve; }),
      async () => undefined,
      'session-unsaved',
      { request: 'Compare rates', answer: 'The curve flattened.' },
    );

    reportUnsavedTurnSummaries();
    expect(error.mock.calls).toEqual([
      ['Turn summary failed session_id=session-unsaved', new Error('The Chat Service stopped before the Turn summary was saved')],
    ]);

    summarized({ title: 'Brief on rates', summary: 'Compared the yields' });
    await saving;
    error.mockClear();
    reportUnsavedTurnSummaries();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
