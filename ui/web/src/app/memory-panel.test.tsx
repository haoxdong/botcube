import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  const alert = await memory.findByRole('alert');
  expect(alert).toHaveTextContent("Couldn't save Memory. Files are unavailable");
  expect(alert.previousElementSibling?.tagName).toBe('HEADER');
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

it('opens the current Written Memory after it changes in Files', async () => {
  writtenMemory('- Lives in Paris\n');
  renderProfile();
  const first = await openMemory('- Lives in Paris');
  fireEvent.click(first.getByRole('button', { name: 'Back' }));

  const refresh = Promise.withResolvers<void>();
  chatService.use(http.get('http://chat.test/files/written-memory', async () => {
    await refresh.promise;
    return HttpResponse.json({ content: '- Lives in London\n' });
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }));
  const current = within(screen.getByRole('article', { name: 'Memory' }));
  expect(current.getByText('- Lives in Paris')).toBeVisible();
  const editButton = current.getByRole('button', { name: 'Edit Memory' });
  expect(editButton).toBeDisabled();

  refresh.resolve();
  expect(await current.findByText('- Lives in London')).toBeVisible();
  expect(editButton).toBeEnabled();
  fireEvent.click(editButton);
  expect(current.getByRole('textbox', { name: 'Memory' })).toHaveValue('- Lives in London\n');
});

/** Counts the Forget requests the Chat Service gets, answering each with `status`. */
function forgetting(status = 202, detail?: string) {
  const requests = { count: 0 };
  chatService.use(http.post('http://chat.test/agent/extracted-memory/forget', () => {
    requests.count += 1;
    return detail === undefined ? new HttpResponse(null, { status }) : HttpResponse.json({ detail }, { status });
  }));
  return requests;
}

const CAPTION = 'Your agent also picks up things from your chats, kept apart from this file.';
const FORGET = 'Forget what it picked up…';

/** The line just above Forget: the caption, or what became of the last Forget in its place. */
const forgetLine = () => screen.getByRole('button', { name: FORGET }).previousElementSibling?.firstElementChild;

async function askToForget() {
  const memory = await openMemory('- Trades copper');
  fireEvent.click(memory.getByRole('button', { name: FORGET }));
  const ask = await screen.findByRole('alertdialog', { name: 'Forget what your agent picked up?' });
  expect(ask).toHaveTextContent('This deletes what your agent learned from your chats. Your Memory text stays as it is.');
  expect(within(ask).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Forget']);
  return { memory, ask };
}

it('keeps the header to Back and Edit, and offers Forget under the Memory card beneath its caption', async () => {
  writtenMemory('- Trades copper\n');
  renderProfile();
  const memory = await openMemory('- Trades copper');

  const header = memory.getByRole('heading', { name: 'Memory' }).closest('header');
  expect(within(header as HTMLElement).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Back', 'Edit Memory']);
  const forget = memory.getByRole('button', { name: FORGET });
  expect(memory.getByText('- Trades copper').compareDocumentPosition(forget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(forgetLine()).toHaveTextContent(new RegExp(`^${CAPTION}$`));
});

it('forgets what the agent picked up once the User confirms, once however often they tap, says it started in place of the caption, and leaves Written Memory as it was', async () => {
  const stored = writtenMemory('- Trades copper\n');
  const requests = forgetting();
  renderProfile();
  const { memory, ask } = await askToForget();

  fireEvent.click(within(ask).getByRole('button', { name: 'Forget' }));
  fireEvent.click(within(ask).getByRole('button', { name: 'Forget' }));

  expect(await screen.findByRole('status')).toHaveTextContent(/^Forgetting started\. It can take a few minutes\.$/);
  expect(forgetLine()).toHaveTextContent(/^Forgetting started\. It can take a few minutes\.$/);
  expect(screen.queryByText(CAPTION)).toBeNull();
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(requests.count).toBe(1);
  expect(memory.getByText('- Trades copper')).toBeVisible();
  expect(stored.content).toBe('- Trades copper\n');
});

it('forgets nothing when the User cancels', async () => {
  writtenMemory('- Trades copper\n');
  const requests = forgetting();
  renderProfile();
  const { ask } = await askToForget();

  fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(requests.count).toBe(0);
  expect(forgetLine()).toHaveTextContent(new RegExp(`^${CAPTION}$`));
});

it('says why Forget failed on the caption\'s line', async () => {
  writtenMemory('- Trades copper\n');
  forgetting(503, 'Session API returned HTTP 503');
  renderProfile();
  const { ask } = await askToForget();

  fireEvent.click(within(ask).getByRole('button', { name: 'Forget' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/^Couldn't start forgetting\. Try again\.$/);
  expect(screen.queryByText(/HTTP 503/)).toBeNull();
  expect(forgetLine()).toHaveRole('alert');
  expect(screen.queryByText(/Forgetting started/)).toBeNull();
});
