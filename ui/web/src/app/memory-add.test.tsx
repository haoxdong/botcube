import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentProfile } from './agent-profile';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openMemory(refuse = false, lines: { id: string; text: string }[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/agent/memory')) {
      if (init?.method === 'POST') {
        if (refuse) return new Response('Unavailable', { status: 503 });
        if (typeof init.body !== 'string') throw new Error('Expected a JSON body');
        const { text } = JSON.parse(init.body) as { text: string };
        const line = { id: 'pending:pending-memory-20261024:event-1', text };
        lines.push(line);
        return Response.json({ line }, { status: 201 });
      }
      return Response.json({ lines: [...lines] });
    }
    if (url.endsWith('/agent/identity')) return Response.json({ name: 'Ada', character: '', vibe: '', avatar: '' });
    if (url.endsWith('/agent/soul')) return Response.json({ content: 'Be kind' });
    return Response.json({ tasks: [] });
  }));
  render(<AgentProfile chatServiceUrl="http://chat.test" profile={null} error={null} revision={0}
    onClose={() => {}} onSaved={() => {}} onOpenChat={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Personalization' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }));
  await screen.findByText(lines[0]?.text ?? 'No memories yet.');
  return screen.getByRole('article', { name: 'Memory' });
}

it('adds a Memory line to an empty page and shows it again after reopening', async () => {
  const page = await openMemory();
  fireEvent.click(within(page).getByRole('button', { name: 'Add Memory' }));
  fireEvent.change(within(page).getByRole('textbox', { name: 'New Memory' }), { target: { value: 'Prefers jasmine tea' } });
  fireEvent.click(within(page).getByRole('button', { name: 'Save Memory' }));
  expect(await within(page).findByText('Prefers jasmine tea')).toBeVisible();
  expect(within(page).queryByRole('textbox', { name: 'New Memory' })).toBeNull();
  fireEvent.click(within(page).getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }));
  expect(await screen.findByText('Prefers jasmine tea')).toBeVisible();
});

it('keeps a failed addition as a draft and shows an error without a saved line', async () => {
  const page = await openMemory(true, [{ id: 'record-1', text: 'Trades copper' }]);
  fireEvent.click(within(page).getByRole('button', { name: 'Add Memory' }));
  fireEvent.change(within(page).getByRole('textbox', { name: 'New Memory' }), { target: { value: 'Prefers jasmine tea' } });
  fireEvent.click(within(page).getByRole('button', { name: 'Save Memory' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Saving Memory failed');
  expect(within(page).getByRole('textbox', { name: 'New Memory' })).toHaveValue('Prefers jasmine tea');
  expect(within(page).queryByText('Saved')).toBeNull();
  expect(within(page).queryByText('Prefers jasmine tea')).toBeNull();
  expect(within(page).getByText('Trades copper')).toBeVisible();
  fireEvent.click(within(page).getByRole('button', { name: 'Cancel editing Memory' }));
  expect(within(page).queryByRole('textbox', { name: 'New Memory' })).toBeNull();
});
