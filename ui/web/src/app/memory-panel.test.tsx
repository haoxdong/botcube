import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { AgentProfile } from './agent-profile';

/** The Chat Service: the agent's Identity and Soul, and the User's Written Memory as `memories/AGENTS.md` holds it. */
const chatService = setupServer();
beforeAll(() => chatService.listen({ onUnhandledRequest: 'error' }));
afterEach(() => chatService.resetHandlers());
afterAll(() => chatService.close());

/** Serves `content` as the User's Written Memory, keeping each save; a save answers `refusal` instead when given one. */
function writtenMemory(content: string, refusal?: { status: number; detail: string }) {
  const stored = { content, reads: 0 };
  chatService.use(
    http.get('http://chat.test/agent/identity', () => HttpResponse.json({ name: 'Ada', character: '', vibe: '', avatar: '' })),
    http.get('http://chat.test/agent/soul', () => HttpResponse.json({ content: 'Be kind' })),
    http.get('http://chat.test/files/written-memory', () => {
      stored.reads += 1;
      return HttpResponse.json({ content: stored.content });
    }),
    http.put('http://chat.test/files/written-memory', async ({ request }) => {
      if (refusal) return HttpResponse.json({ detail: refusal.detail }, { status: refusal.status });
      stored.content = ((await request.json()) as { content: string }).content;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return stored;
}

function renderProfile(memory?: boolean) {
  render(<AgentProfile chatServiceUrl="http://chat.test" profile={null} error={null} revision={0} {...(memory === undefined ? {} : { memory })}
    onClose={() => {}} onSaved={() => {}} onOpenChat={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Personalization' }));
}

async function openMemory(shown: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Open Memory' }));
  await screen.findByText(shown);
  return within(screen.getByRole('article', { name: 'Memory' }));
}

function edit(memory: ReturnType<typeof within>, content: string) {
  fireEvent.click(memory.getByRole('button', { name: 'Edit Memory' }));
  fireEvent.change(memory.getByRole('textbox', { name: 'Memory' }), { target: { value: content } });
  fireEvent.click(memory.getByRole('button', { name: 'Save Memory' }));
}

it("shows the User's Written Memory as its text, and saves an edit that shows again on reopening", async () => {
  const stored = writtenMemory('- Prefers jasmine tea\n- Lives in Paris\n');
  renderProfile();
  const memory = await openMemory('- Prefers jasmine tea - Lives in Paris');

  fireEvent.click(memory.getByRole('button', { name: 'Edit Memory' }));
  expect(memory.getByRole<HTMLTextAreaElement>('textbox', { name: 'Memory' }).value).toBe('- Prefers jasmine tea\n- Lives in Paris\n');
  fireEvent.click(memory.getByRole('button', { name: 'Cancel editing Memory' }));
  edit(memory, '- Prefers green tea\n');

  expect(await memory.findByRole('status')).toHaveTextContent('Saved');
  expect(stored.content).toBe('- Prefers green tea\n');
  fireEvent.click(memory.getByRole('button', { name: 'Back' }));
  expect((await openMemory('- Prefers green tea')).getByText('- Prefers green tea')).toBeVisible();
});

it('says an empty Written Memory holds no memories yet, and lets the User write the first', async () => {
  const stored = writtenMemory('  \n');
  renderProfile();
  expect(await screen.findByRole('button', { name: 'Open Memory' })).toHaveTextContent(/No memories yet$/);
  const memory = await openMemory('No memories yet.');

  edit(memory, '- Prefers jasmine tea\n');

  expect(await memory.findByRole('status')).toHaveTextContent('Saved');
  expect(memory.getByText('- Prefers jasmine tea')).toBeVisible();
  expect(memory.queryByText('No memories yet.')).toBeNull();
  expect(stored.content).toBe('- Prefers jasmine tea\n');
});

it('keeps a failed save as a draft and says why', async () => {
  const stored = writtenMemory('- Trades copper\n', { status: 503, detail: 'Files are unavailable' });
  renderProfile();
  const memory = await openMemory('- Trades copper');

  edit(memory, '- Trades gold\n');

  expect(await screen.findByRole('alert')).toHaveTextContent(/^Saving Memory failed: Files are unavailable$/);
  expect(memory.getByRole('textbox', { name: 'Memory' })).toHaveValue('- Trades gold\n');
  expect(memory.queryByText('Saved')).toBeNull();
  expect(stored.content).toBe('- Trades copper\n');
});

it('shows no Memory card and loads no Written Memory when the User keeps none', async () => {
  const stored = writtenMemory('- Trades copper\n');
  renderProfile(false);

  expect(await screen.findByRole('button', { name: 'Open Soul' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Open Memory' })).toBeNull();
  expect(stored.reads).toBe(0);
});
