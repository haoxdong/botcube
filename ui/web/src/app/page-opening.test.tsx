import { Component, type ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
afterEach(() => { state.release(); cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.doUnmock('./chat-app'); vi.doUnmock('./kept-markdown'); });

it('shows saved history while the live chat module is still loading', async () => {
  const { default: Page } = await import('./page');
  render(<Page />);
  expect(await screen.findByText('The saved answer.')).toBeVisible();
  expect(screen.getByText('The saved answer.').closest('.app-chat')).not.toHaveStyle({ opacity: '0' });
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

function formattedCopy() {
  performance.clearMeasures('latency:history-returning');
  localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'saved-account', id: 'saved-chat', messages: [
    { id: 'answer', role: 'assistant', content: '**Formatted saved answer.**' },
  ] }));
}

function holdMarkdown() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const loaded = vi.importActual<typeof import('./kept-markdown')>('./kept-markdown');
  vi.doMock('./kept-markdown', async () => { await gate; return loaded; });
  return () => { release(); return loaded; };
}

it('waits for formatted saved history before showing and timing it', async () => {
  const release = holdMarkdown();
  formattedCopy();
  const { default: Page } = await import('./page');
  render(<Page />);
  expect(screen.getByRole('status', { name: 'Loading Main Chat' })).toBeVisible();
  expect(screen.queryByText('Formatted saved answer.')).toBeNull();
  expect(performance.getEntriesByName('latency:history-returning', 'measure')).toHaveLength(0);
  await act(async () => { await release(); });
  expect(await screen.findByText('Formatted saved answer.')).toBeVisible();
  await waitFor(() => expect(performance.getEntriesByName('latency:history-returning', 'measure')).toHaveLength(1));
});

it('shows prepared history when auth completes for the same account first', async () => {
  const release = holdMarkdown();
  formattedCopy();
  const { default: Page } = await import('./page');
  const view = render(<Page />);
  state.auth.sessionStatus = 'ready';
  state.auth.accountId = 'saved-account';
  view.rerender(<Page />);
  await act(async () => { await release(); });
  expect(await screen.findByText('Formatted saved answer.')).toBeVisible();
});

it('does not reveal a previous account when its formatter finishes late', async () => {
  const release = holdMarkdown();
  formattedCopy();
  const { default: Page } = await import('./page');
  const view = render(<Page />);
  state.auth.sessionStatus = 'ready';
  state.auth.accountId = 'other-account';
  view.rerender(<Page />);
  state.auth.sessionStatus = 'loading';
  state.auth.accountId = undefined;
  view.rerender(<Page />);
  await act(async () => { state.release(); await release(); await vi.dynamicImportSettled(); });
  expect(screen.queryByText('Formatted saved answer.')).toBeNull();
  expect(screen.queryByText('saved-account')).toBeNull();
  state.auth.sessionStatus = 'ready';
  state.auth.accountId = 'other-account';
  view.rerender(<Page />);
  expect(screen.getByRole('status', { name: 'Live chat' })).toHaveTextContent('other-account');
});

class OpeningFailure extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children; }
}

it('ignores failed formatter preparation from a replaced account', async () => {
  formattedCopy();
  let rejectPreparation: (error: Error) => void = () => {};
  const pending = new Promise<void>((_resolve, reject) => { rejectPreparation = reject; });
  const kept = await import('./kept-chat');
  const prepare = vi.spyOn(kept, 'prepareKeptChat').mockReturnValue(pending);
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { default: Page } = await import('./page');
    const view = render(<OpeningFailure><Page /></OpeningFailure>);
    state.auth.sessionStatus = 'ready';
    state.auth.accountId = 'other-account';
    view.rerender(<OpeningFailure><Page /></OpeningFailure>);
    state.auth.sessionStatus = 'loading';
    state.auth.accountId = undefined;
    view.rerender(<OpeningFailure><Page /></OpeningFailure>);
    await act(async () => { state.release(); rejectPreparation(new Error('Old formatter failed')); await vi.dynamicImportSettled(); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading Main Chat' })).toBeVisible();
  } finally { prepare.mockRestore(); report.mockRestore(); }
});

it('reports a failed formatter without timing absent history', async () => {
  formattedCopy();
  const kept = await import('./kept-chat');
  const prepare = vi.spyOn(kept, 'prepareKeptChat').mockImplementation(() => Promise.reject(new Error('Saved formatter unavailable')));
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { default: Page } = await import('./page');
    render(<OpeningFailure><Page /></OpeningFailure>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved formatter unavailable');
    expect(screen.queryByText('Formatted saved answer.')).toBeNull();
    expect(performance.getEntriesByName('latency:history-returning', 'measure')).toHaveLength(0);
  } finally { prepare.mockRestore(); report.mockRestore(); }
});
