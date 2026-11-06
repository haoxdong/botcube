// @vitest-environment node
import { expect, it } from 'vitest';
import { draftOf, edited } from './scheduled-task-draft';
import type { ScheduledTask } from './scheduled-task';

it('refuses an end time that does not exist in the task timezone', () => {
  const task: ScheduledTask = {
    id: 'gap-task', title: 'Brief', prompt: 'Brief me',
    schedule: 'cron(0 12 * * ? *)', timezone: 'America/New_York',
    startDate: '2027-03-01T17:00:00.000Z',
    paused: false, proposalId: 'gap-proposal', ended: false, sideChat: null,
  };
  const draft = draftOf(task, 'model');
  draft.ends = { choice: 'on', on: '2027-03-14T02:30', count: null };
  expect(edited(draft, task, 'model')).toEqual({ why: expect.any(String) });
});
