import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

let stack: InProcessStack;
beforeAll(async () => { stack = await startInProcess(); });
afterAll(async () => { await stack.stop(); });

it('lists unread completed chats and shares read acknowledgements across clients', async () => {
  const running = { startedAt: '2026-01-01T00:00:00.000Z', runId: 'unread-run' };
  await stack.sessionMetadata.recordTurn('account-1', 'unread-chat', { filingUserId: 'account-1', title: 'Unread', running, allocation: true });
  await stack.sessionMetadata.turnEnded('account-1', 'unread-chat', running, undefined);
  const first = await stack.app.request('/threads');
  expect(first.status).toBe(200);
  const { threads: chats } = await first.json() as { threads: { id: string; turn_completed_at: string; read_at?: string }[] };
  const chat = chats.find(({ id }) => id === 'unread-chat');
  expect(chat).toMatchObject({ id: 'unread-chat', turn_completed_at: expect.any(String) });
  const read = await stack.app.request('/threads/unread-chat/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completedAt: chat?.turn_completed_at }) });
  expect(read.status).toBe(204);
  const second = await stack.app.request('/threads');
  expect(await second.json()).toMatchObject({ threads: [{ id: 'unread-chat', read_at: chat?.turn_completed_at }] });
});


it('refuses malformed and foreign read acknowledgements without creating read state', async () => {
  const malformed = await stack.app.request('/threads/unread-chat/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(malformed.status).toBe(422);
  const foreign = await stack.app.request('/threads/unread-chat/read', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'other-account' }, body: JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }) });
  expect(foreign.status).toBe(410);
  expect(await (await stack.app.request('/threads', { headers: { 'x-test-owner': 'other-account' } })).json()).toEqual({ threads: [] });
});

it('acknowledges the watched completed run without clearing a newer run or scheduled post', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-01-01T00:00:00.000Z');
  onTestFinished(() => { vi.useRealTimers(); });
  const meta = stack.sessionMetadata;
  const first = { startedAt: '2026-01-01T00:00:00.000Z', runId: 'watched-first' };
  await meta.recordTurn('account-1', 'watched-chat', { filingUserId: 'account-1', title: 'Watched', running: first, allocation: true });
  await meta.turnEnded('account-1', 'watched-chat', first, undefined);
  const acknowledge = () => stack.app.request('/threads/watched-chat/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: first.runId }) });
  expect((await acknowledge()).status).toBe(204);
  const read = await meta.get('account-1', 'watched-chat');
  expect(read).toMatchObject({ read_at: '2026-01-01T00:00:00.000Z', turn_completed_at: '2026-01-01T00:00:00.000Z' });
  const next = { startedAt: '2026-01-01T00:00:01.000Z', runId: 'watched-next' };
  await meta.recordTurn('account-1', 'watched-chat', { filingUserId: 'account-1', title: 'Watched', running: next });
  vi.setSystemTime('2026-01-01T00:00:01.000Z');
  await meta.turnEnded('account-1', 'watched-chat', next, undefined);
  await acknowledge();
  expect((await meta.get('account-1', 'watched-chat'))?.read_at).toBe(read?.read_at);
  await meta.recordTurn('account-1', 'watched-chat', { filingUserId: 'account-1', title: 'Watched', messageId: 'scheduled-post', postAcceptance: true });
  vi.setSystemTime('2026-01-01T00:00:02.000Z');
  await meta.markPosted('account-1', 'watched-chat', 'scheduled-post');
  const oldRun = await stack.app.request('/threads/watched-chat/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: next.runId }) });
  expect(oldRun.status).toBe(204);
  expect((await meta.get('account-1', 'watched-chat'))?.read_at).toBe(read?.read_at);
});


it.each(['', 7])('refuses a malformed watched-run acknowledgement: %s', async (runId) => {
  const response = await stack.app.request('/threads/watched-chat/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) });
  expect(response.status).toBe(422);
});
