import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProfile } from './agent-profile';

const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock('./scheduled-tasks', () => {
  loaded();
  return { ScheduledPanel: () => <p>Schedule loaded</p> };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('loads the Scheduled panel only when its tab opens', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Marq', character: '', vibe: '', avatar: '' })));
  render(<AgentProfile open chatServiceUrl="http://chat.test" profile={null} error={null}
    computer={() => <p>Computer loaded</p>} onClose={() => {}} revision={0}
    onSaved={() => {}} onOpenChat={() => {}} />);
  expect(screen.getByText('Computer loaded')).toBeInTheDocument();
  expect(loaded).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('tab', { name: 'Scheduled' }));
  expect(await screen.findByText('Schedule loaded')).toBeInTheDocument();
  expect(loaded).toHaveBeenCalledOnce();
});
