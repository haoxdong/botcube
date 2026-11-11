import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ArtifactLayout, publishedOf } from './artifact-panel';
import MarkdownRenderer from './markdown-renderer';

const PAGE = '<!doctype html><html><head><title>Q3 revenue</title></head><body><h1>Q3</h1></body></html>';
const PUBLISHED = {
  id: '/reports/q3.html', type: null, title: 'Q3 revenue by month', description: 'Monthly revenue against plan',
  version: 2, path: '/artifacts/reports/q3.html.versions/2.html',
};

const reply = (result: string = JSON.stringify(PUBLISHED)) => [
  { id: 'u', role: 'user' as const, content: 'Chart Q3 revenue' },
  {
    id: 'a', role: 'assistant' as const, content: '',
    toolCalls: [{ id: 'c', type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/reports/q3.html', title: PUBLISHED.title }) } }],
  },
  { id: 't', role: 'tool' as const, toolCallId: 'c', content: result },
];

function Chat({ messages = reply() }: { messages?: ReturnType<typeof reply> }) {
  return (
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout>
          <div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div>
        </ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

function files() {
  const fetchImpl = vi.fn(async (input: string) => {
    if (input === 'https://files.test/2.html') return new Response(PAGE);
    const name = new URL(input).searchParams.get('name');
    return name === 'artifacts/reports/q3.html.versions/2.html'
      ? Response.json({ url: 'https://files.test/2.html' })
      : Response.json({ detail: `No file named ${name}` }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchImpl);
}

const phone = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: matches && query === '(max-width: 640px)', media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);

/**
 * The sandbox page saying it is ready, as `public/artifact-sandbox/index.html` does once it loads; happy-dom loads no
 * frame, so the frame's window is a stand-in that records what the panel posts to it.
 */
function sandboxReady(frame: HTMLIFrameElement) {
  const posted = vi.fn();
  const sandbox = { postMessage: posted } as unknown as Window;
  Object.defineProperty(frame, 'contentWindow', { value: sandbox, configurable: true });
  void act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'artifact-sandbox-ready' }, origin: 'null', source: sandbox })));
  return posted;
}

beforeEach(files);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows a published Artifact as a card with its title, type, version and description", async () => {
  phone(false);
  render(<Chat />);

  const card = await screen.findByRole('button', { name: /Q3 revenue by month/ });
  expect(card).toHaveTextContent('Q3 revenue by monthPage · version 2Monthly revenue against plan');
});

it('opens the page beside the chat on desktop, in its sandbox, and expands it to full screen and back', async () => {
  phone(false);
  const view = render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));

  const panel = screen.getByRole('region', { name: 'Q3 revenue by month' });
  expect(view.container.querySelector('.app-chat')).toBeInTheDocument();
  expect(panel).not.toHaveAttribute('data-full');
  const frame = within(panel).getByTitle<HTMLIFrameElement>('Q3 revenue by month');
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-modals');
  expect(frame).toHaveAttribute('src', '/artifact-sandbox/');
  const posted = sandboxReady(frame);
  await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'artifact-page', html: PAGE }, '*'));

  await userEvent.click(within(panel).getByRole('button', { name: 'Full screen' }));
  expect(panel).toHaveAttribute('data-full');
  await userEvent.click(within(panel).getByRole('button', { name: 'Exit full screen' }));
  expect(panel).not.toHaveAttribute('data-full');

  await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('region', { name: 'Q3 revenue by month' })).toBeNull();
});

it('opens the page full screen on a phone', async () => {
  phone(true);
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));

  const sheet = await screen.findByRole('dialog', { name: 'Q3 revenue by month' });
  expect(within(sheet).getByTitle('Q3 revenue by month')).toHaveAttribute('sandbox', 'allow-scripts allow-modals');
  expect(within(sheet).queryByRole('button', { name: 'Full screen' })).toBeNull();
});

it('prints the page as shown for Download as PDF', async () => {
  phone(false);
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const posted = sandboxReady(screen.getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));

  await userEvent.click(screen.getByRole('button', { name: 'Download as PDF' }));

  expect(posted).toHaveBeenLastCalledWith({ type: 'artifact-print' }, '*');
});

it("shows a refused publish's message in place of a card", async () => {
  phone(false);
  render(<Chat messages={reply("Error invoking tool 'Artifact' with kwargs {}: No file at /reports/q3.html. Write the page there, then publish it.")} />);

  expect(await screen.findByText(/No file at \/reports\/q3\.html/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Q3 revenue by month/ })).toBeNull();
});

it('throws on a JSON result that is no Artifact, rather than show it as refused', () => {
  expect(publishedOf("Error invoking tool 'Artifact': No file at /q3.html.")).toBeNull();
  expect(() => publishedOf(JSON.stringify({ ...PUBLISHED, version: '2' }))).toThrow();
});

it("still shows an old reply's Download link as its file card", async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ url: 'https://files.test/q3-board-deck.pptx' })));
  const view = render(<MarkdownRenderer content={'[Download q3-board-deck.pptx](/artifacts/q3-board-deck.pptx)'} />);

  expect(await view.findByRole('link', { name: 'Download q3-board-deck.pptx' })).toHaveClass('reply-file');
});
