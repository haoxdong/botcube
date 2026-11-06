import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProfile } from './agent-profile';

const { loaded, activityLoaded } = vi.hoisted(() => ({ loaded: vi.fn(), activityLoaded: vi.fn() }));
vi.mock('./scheduled-tasks', () => {
  loaded();
  return { ScheduledPanel: () => <p>Schedule loaded</p> };
});

vi.mock('./agent-activity', () => {
  activityLoaded();
  return { ActivityPanel: () => <p>Activity loaded</p> };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('loads the Scheduled and Activity panels only when their tabs open', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Marq', character: '', vibe: '', avatar: '' })));
  render(<AgentProfile open chatServiceUrl="http://chat.test" profile={null} error={null}
    computer={() => <p>Computer loaded</p>} onClose={() => {}} revision={0}
    onSaved={() => {}} onOpenChat={() => {}} tabs={{}} />);
  expect(screen.getByText('Computer loaded')).toBeInTheDocument();
  expect(loaded).not.toHaveBeenCalled();
  expect(activityLoaded).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('tab', { name: 'Scheduled' }));
  expect(await screen.findByText('Schedule loaded')).toBeInTheDocument();
  expect(loaded).toHaveBeenCalledOnce();
  expect(activityLoaded).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
  expect(await screen.findByText('Activity loaded')).toBeInTheDocument();
  expect(activityLoaded).toHaveBeenCalledOnce();
});
