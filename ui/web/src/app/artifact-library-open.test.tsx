import { HttpAgent } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ArtifactLayout } from './artifact-panel';
import { Published } from './artifact-published';
import { useArtifactWorkspace, useChatSurfaceKey, type ArtifactRequest } from './artifact-request';

const artifact = Published.parse({ id: '/dashboard.html', type: null, title: 'Revenue dashboard', description: '', version: 1, path: '/artifacts/dashboard.html.versions/1.html' });
const agent = new HttpAgent({ url: 'https://chat.test/agent' });

function LibraryLaunch({ accountId = 'hao' }: { accountId?: string }) {
  const [request, setRequest] = useState<ArtifactRequest>();
  return <CopilotKitProvider><CopilotChatConfigurationProvider threadId="library-open">
    <button type="button" onClick={() => setRequest({ accountId: 'hao', artifact, handled: () => setRequest(undefined) })}>Open from library</button>
    <ArtifactLayout agent={agent} accountId={accountId} request={request}><div className="app-chat">Chat stays here</div></ArtifactLayout>
  </CopilotChatConfigurationProvider></CopilotKitProvider>;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/files') return Response.json({ files: [{ name: artifact.path.slice(1), size: 1, lastModified: '2026-11-15T18:00:00Z' }] });
    if (url.pathname === '/files/download-url') return url.searchParams.get('name')?.endsWith('/2.html')
      ? Response.json({}, { status: 404 }) : Response.json({ url: 'https://files.test/page' });
    return new Response('<!doctype html><h1>Revenue dashboard</h1>');
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('opens a library selection and can reopen the same Artifact after closing it', async () => {
  const view = render(<LibraryLaunch />);
  const chat = view.container.querySelector('.app-chat');
  await userEvent.click(screen.getByRole('button', { name: 'Open from library' }));
  expect(await screen.findByRole('region', { name: 'Revenue dashboard' })).toBeVisible();
  expect(view.container.querySelector('.app-chat')).toBe(chat);
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Revenue dashboard' })).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Open from library' }));
  expect(await screen.findByRole('region', { name: 'Revenue dashboard' })).toBeVisible();
});

it('does not open a selection belonging to another account', async () => {
  render(<LibraryLaunch accountId="another-user" />);
  await userEvent.click(screen.getByRole('button', { name: 'Open from library' }));
  expect(screen.queryByRole('region', { name: 'Revenue dashboard' })).not.toBeInTheDocument();
});

function LibraryWithoutChat({ accountId, chatId = null }: { accountId: string; chatId?: string | null }) {
  const { request, initialized, select } = useArtifactWorkspace({ accountId });
  const key = useChatSurfaceKey(accountId, chatId, initialized);
  const failed = <p role="alert">Main Chat unavailable</p>;
  return <CopilotKitProvider><CopilotChatConfigurationProvider threadId="library-without-chat">
    <button type="button" onClick={() => select(artifact)}>Open from library</button>
    {initialized ? <ArtifactLayout key={key} agent={agent} accountId={accountId} request={request}>{chatId === null ? failed : <p>Chat recovered</p>}</ArtifactLayout> : failed}
  </CopilotChatConfigurationProvider></CopilotKitProvider>;
}

it('keeps the library pane available without a loaded chat, and drops its workspace on account change', async () => {
  const view = render(<LibraryWithoutChat accountId="hao" />);
  await userEvent.click(screen.getByRole('button', { name: 'Open from library' }));
  expect(await screen.findByRole('region', { name: 'Revenue dashboard' })).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Main Chat unavailable');
  view.rerender(<LibraryWithoutChat accountId="another-user" />);
  expect(screen.queryByRole('region', { name: 'Revenue dashboard' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Main Chat unavailable');
});

 it('preserves the open Artifact when Main Chat recovers and resets it for a different chat', async () => {
  const view = render(<LibraryWithoutChat accountId="hao" />);
  await userEvent.click(screen.getByRole('button', { name: 'Open from library' }));
  const panel = await screen.findByRole('region', { name: 'Revenue dashboard' });
  view.rerender(<LibraryWithoutChat accountId="hao" chatId="main" />);
  expect(screen.getByRole('region', { name: 'Revenue dashboard' })).toBe(panel);
  expect(screen.getByText('Chat recovered')).toBeVisible();
  view.rerender(<LibraryWithoutChat accountId="hao" chatId={null} />);
  expect(screen.getByRole('region', { name: 'Revenue dashboard' })).toBe(panel);
  view.rerender(<LibraryWithoutChat accountId="hao" chatId="side-chat" />);
  expect(screen.queryByRole('region', { name: 'Revenue dashboard' })).not.toBeInTheDocument();
});
