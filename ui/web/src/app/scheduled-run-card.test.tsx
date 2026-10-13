import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { OpenScheduledRun, ScheduledRunCard } from './scheduled-run-card';
import type { ScheduledRun } from './scheduled-tasks';

const RUN = { title: 'Morning brief', ranAt: '2026-10-09T12:00:00.000Z', text: 'Rates fell.' };

const card = (run: ScheduledRun) => {
  const open = vi.fn();
  const { container } = render(
    <OpenScheduledRun.Provider value={open}>
      <ScheduledRunCard run={run} />
    </OpenScheduledRun.Provider>,
  );
  return { card: within(container), open };
};

it.each([
  ['done', 'Done'],
  ['failed', 'Failed'],
  ['sign-in', 'Needs sign-in'],
  ['skipped', 'Skipped'],
] as const)('labels a %s run as the task sheet does: %s', (status, label) => {
  card({ ...RUN, status, sideChat: 'task-1', messageId: 'm-1' });

  expect(screen.getByText(label)).toHaveClass('status-pill');
});

it('opens a run that reached its Side Chat there, at its request', async () => {
  const run = { ...RUN, status: 'done', sideChat: 'task-1', messageId: 'm-1' } as const;
  const { card: shown, open } = card(run);

  shown.getByRole('button', { name: 'Open' }).click();

  expect(open).toHaveBeenCalledWith(run);
});

// A skipped run, or one that failed before its Side Chat, has nowhere to open.
it('offers no Open for a run that never reached its Side Chat', () => {
  const { card: shown } = card({ ...RUN, status: 'skipped', text: 'the task was paused' });

  expect(shown.getByText('Skipped')).toHaveClass('status-pill');
  expect(shown.queryByRole('button', { name: 'Open' })).toBeNull();
});
