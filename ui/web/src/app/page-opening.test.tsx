import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthProviderProps, AuthUiState } from '../cartridge';
import type { StoredMainChatCopy } from './main-chat-copy';

const state = vi.hoisted(() => {
  const auth: AuthUiState = { sessionStatus: 'loading', status: 'authed', error: null, login() {}, logout() {}, relink() {} };
  return { auth, gate: Promise.resolve(), release: () => {} };
});

vi.mock('@cartridge-ui', () => ({ webUiPlugin: {
  config: { title: 'Test', agentName: 'Agent', disclaimer: 'Check important information.', agentId: 'agent' },
  AuthProvider: ({ children }: AuthProviderProps) => children(state.auth),
} }));


beforeEach(() => {
  vi.resetModules();
  state.auth.sessionStatus = 'loading';
  state.auth.accountId = undefined;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  state.gate = new Promise<void>((resolve) => { state.release = resolve; });
  vi.doMock('./chat-app', async () => {
    await state.gate;
    return { default: ({ auth, opening }: { auth: AuthUiState; opening: StoredMainChatCopy | null }) =>
      <div role="status" aria-label="Live chat">{auth.accountId ?? opening?.accountId}</div> };
  });
  localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'saved-account', id: 'saved-chat', messages: [
    { id: 'answer', role: 'assistant', content: 'The saved answer.' },
  ] }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.doUnmock('./chat-app'); });

it('shows saved history while the live chat module is still loading', async () => {
  const { default: Page } = await import('./page');
  render(<Page />);
  expect(await screen.findByText('The saved answer.')).toBeVisible();
  expect(screen.queryByRole('status', { name: 'Live chat' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Main Chat' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Agent profile' })).toBeDisabled();
  await act(async () => { state.release(); await vi.dynamicImportSettled(); });
  expect(screen.getByRole('status', { name: 'Live chat' })).toHaveTextContent('saved-account');
});

it("removes another account's saved history before the live module finishes loading", async () => {
  const { default: Page } = await import('./page');
  const view = render(<Page />);
  expect(await screen.findByText('The saved answer.')).toBeVisible();
  state.auth.sessionStatus = 'ready';
  state.auth.accountId = 'other-account';
  view.rerender(<Page />);
  expect(screen.queryByText('The saved answer.')).toBeNull();
  await act(async () => { state.release(); await vi.dynamicImportSettled(); });
  expect(screen.getByRole('status', { name: 'Live chat' })).toHaveTextContent('other-account');
});

it('keeps matching saved history through auth completion while the live module is pending', async () => {
  const { default: Page } = await import('./page');
  const view = render(<Page />);
  expect(await screen.findByText('The saved answer.')).toBeVisible();
  state.auth.sessionStatus = 'ready';
  state.auth.accountId = 'saved-account';
  view.rerender(<Page />);
  expect(screen.getByText('The saved answer.')).toBeVisible();
  await act(async () => { state.release(); await vi.dynamicImportSettled(); });
  expect(screen.getByRole('status', { name: 'Live chat' })).toHaveTextContent('saved-account');
});

it('keeps loading feedback while a first visit waits for the live module', async () => {
  localStorage.clear();
  state.auth.sessionStatus = 'ready';
  state.auth.accountId = 'new-account';
  const { default: Page } = await import('./page');
  render(<Page />);
  expect(screen.getByRole('status', { name: 'Loading Main Chat' })).toBeVisible();
  await act(async () => { state.release(); await vi.dynamicImportSettled(); });
  expect(screen.getByRole('status', { name: 'Live chat' })).toHaveTextContent('new-account');
});
