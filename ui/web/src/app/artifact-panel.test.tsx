import { HttpAgent } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider, useAgent } from '@copilotkit/react-core/v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactLayout, publishedOf } from './artifact-panel';
import recorded from './artifact-live-fill.stream.json';
import MarkdownRenderer from './markdown-renderer';

const PAGE = '<!doctype html><html><head><title>Q3 revenue</title></head><body><h1>Q3</h1></body></html>';
const PUBLISHED = {
  id: '/reports/q3.html', type: null, title: 'Q3 revenue by month', description: 'Monthly revenue against plan',
  version: 2, path: '/artifacts/reports/q3.html.versions/2.html',
};

/** The chat's agent when no turn runs: these chats show saved messages. */
const IDLE = new HttpAgent({ url: 'https://chat.test/agent' });

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
        <ArtifactLayout agent={IDLE}>
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
function sandboxReady(frame: HTMLIFrameElement, posted = vi.fn()) {
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

describe('while the agent writes', () => {
  /** The page the recorded turn writes, as its write_file call's `content`. */
  const WRITTEN = '<!doctype html><html><head><meta charset="utf-8"><title>Q3 revenue</title>'
    + '<style>body{font-family:system-ui;margin:24px}h1{color:#ad4ed8}</style></head><body>'
    + '<h1>Q3 revenue</h1><p>July 15.1, August 16.0, September 17.1 ($m).</p>'
    + '<p id="chart">The chart draws once the page is complete.</p>'
    + '<script>document.getElementById("chart").textContent = "Chart drawn: " + [15.1, 16.0, 17.1].join(" / ");</script>'
    + '</body></html>';
  /** The page in Files after the turn's edit_file. */
  const EDITED = WRITTEN.replace('September 17.1', 'September 17.4');
  const REFUSAL = "Error invoking tool 'Artifact' with kwargs {}: Save the page in Files to publish it: /reports/q3.html";

  type Recorded = { atMs: number } & Record<string, unknown>;
  const TURN: readonly Recorded[] = recorded.events;
  const at = (type: string, toolCallId: string) => {
    const event = TURN.find((candidate) => candidate.type === type && candidate.toolCallId === toolCallId);
    if (event === undefined) throw new Error(`The recorded turn has no ${type} for ${toolCallId}`);
    return event.atMs;
  };
  const WRITE_ENDS = at('TOOL_CALL_END', 'write');
  const PUBLISHED = at('TOOL_CALL_RESULT', 'publish');
  const EDIT_COMPLETES = at('TOOL_CALL_RESULT', 'edit');
  const REPUBLISHED = at('TOOL_CALL_RESULT', 'republish');
  const TURN_ENDS = TURN.at(-1)?.atMs ?? Number.NaN;

  /** The recorded turn with the Artifact call `toolCallId` refused. */
  const refusing = (toolCallId: string) => TURN.map((event) =>
    event.type === 'TOOL_CALL_RESULT' && event.toolCallId === toolCallId ? { ...event, content: REFUSAL } : event);

  /** The Chat Service's stream of a turn: each event at its recorded time. */
  function turnStream(events: readonly Recorded[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { atMs, ...event } of events) {
          setTimeout(() => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)), atMs);
        }
        setTimeout(() => controller.close(), TURN_ENDS + 1);
      },
    });
  }

  /** The agent's turn from the Chat Service, and Files holding the Source as the edit left it and both versions. */
  function services(events: readonly Recorded[]) {
    const files: Record<string, string> = {
      'reports/q3.html': EDITED,
      'artifacts/reports/q3.html.versions/1.html': WRITTEN,
      'artifacts/reports/q3.html.versions/2.html': EDITED,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === 'https://chat.test/agent') return new Response(turnStream(events), { headers: { 'content-type': 'text/event-stream' } });
      if (input.startsWith('https://files.test/')) return new Response(files[decodeURIComponent(input.slice('https://files.test/'.length))]);
      const name = new URL(input).searchParams.get('name') ?? '';
      return name in files
        ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` })
        : Response.json({ detail: `No file named ${name}` }, { status: 404 });
    }));
  }

  function Messages() {
    const { agent } = useAgent();
    return <CopilotChatMessageView messages={agent.messages} isRunning={agent.isRunning} />;
  }

  function LiveChat({ agent }: { agent: HttpAgent }) {
    return (
      <CopilotKitProvider selfManagedAgents={{ default: agent }}>
        <CopilotChatConfigurationProvider threadId="thread">
          <ArtifactLayout agent={agent}>
            <div className="app-chat"><Messages /></div>
          </ArtifactLayout>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    );
  }

  type Sent = { at: number; message: { type: string; html?: string } };

  /**
   * The chat, with `before` in it, ready for a turn of `events`; it records what the panel sends each sandbox page
   * once it is ready, with when.
   */
  function chat(events = TURN, before: ReturnType<typeof reply> = []) {
    phone(false);
    services(events);
    const agent = new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread', initialMessages: before });
    render(<LiveChat agent={agent} />);
    const sent: Sent[] = [];
    const loaded = new Set<Element>();
    // Times count from the start of the turn, as the recording's do.
    let started = 0;
    const now = () => Date.now() - started;
    // Time moves a frame at a time, React rendering between frames as a browser would, and each frame the panel
    // opens loads its sandbox page.
    const until = async (ms: number): Promise<void> => {
      if (now() >= ms) return;
      await act(() => vi.advanceTimersByTimeAsync(Math.min(16, ms - now())));
      for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.artifact-frame')) {
        if (loaded.has(frame)) continue;
        loaded.add(frame);
        sandboxReady(frame, vi.fn((message: Sent['message']) => sent.push({ at: now(), message })));
      }
      return until(ms);
    };
    const run = () => act(() => {
      started = Date.now();
      void agent.runAgent();
    });
    return { sent, until, run };
  }

  const previews = (sent: Sent[]) => sent.filter(({ message }) => message.type === 'artifact-preview');
  const pages = (sent: Sent[]) => sent.filter(({ message }) => message.type === 'artifact-page');

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a preview beside the chat and fills it before the write completes, at most four renders a second', async () => {
    const { sent, until, run } = chat();
    await run();

    await until(WRITE_ENDS - 5);

    expect(screen.getByRole('region', { name: 'q3.html' })).toBeInTheDocument();
    expect(pages(sent)).toEqual([]);
    expect(previews(sent).length).toBeGreaterThanOrEqual(6);
    expect(sent.at(-1)?.message.html).toContain('<h1>Q3 revenue</h1><p>July 15.1');
    const times = sent.map(({ at }) => at);
    expect(Math.min(...times.slice(1).map((time, index) => time - (times[index] ?? Number.NaN)))).toBeGreaterThanOrEqual(250);
  });

  it('previews the written file without its scripts, and runs them once its publish opens the version', async () => {
    const { sent, until, run } = chat();
    await run();

    await until(PUBLISHED - 5);
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-preview', html: WRITTEN });
    expect(pages(sent)).toEqual([]);

    await until(PUBLISHED + 50);
    expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toHaveTextContent('Page · version 1');
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-page', html: WRITTEN });
  });

  it("keeps the published version open while the agent edits its Source, and opens the next once it's published", async () => {
    const { sent, until, run } = chat();
    await run();

    await until(REPUBLISHED - 5);
    expect(sent.filter(({ at }) => at > PUBLISHED).map(({ message }) => message)).toEqual([{ type: 'artifact-page', html: WRITTEN }]);

    await until(TURN_ENDS + 10);
    expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toHaveTextContent('Page · version 2');
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-page', html: EDITED });
  });

  it('keeps the last good version when a publish is refused', async () => {
    const { sent, until, run } = chat(refusing('republish'));
    await run();

    await until(TURN_ENDS + 10);

    expect(screen.getByText(REFUSAL)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toHaveTextContent('Page · version 1');
    expect(sent.filter(({ at }) => at > PUBLISHED).map(({ message }) => message)).toEqual([{ type: 'artifact-page', html: WRITTEN }]);
  });

  it('keeps previewing without scripts when the first publish is refused, and shows an edit_file once it completes', async () => {
    const { sent, until, run } = chat(refusing('publish'));
    await run();

    await until(EDIT_COMPLETES - 5);
    expect(screen.getByText(REFUSAL)).toBeInTheDocument();
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-preview', html: WRITTEN });

    await until(EDIT_COMPLETES + 50);
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-preview', html: EDITED });
    expect(pages(sent)).toEqual([]);

    await until(TURN_ENDS + 10);
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-page', html: EDITED });
  });

  it("keeps a card's version open while the agent writes its Source, until the publish opens the new version", async () => {
    const { sent, until, run } = chat(TURN, reply());
    await until(16);
    await act(() => screen.getByRole('button', { name: /Q3 revenue by month/ }).click());
    await until(100);
    expect(sent.map(({ message }) => message)).toEqual([{ type: 'artifact-page', html: EDITED }]);
    await run();

    await until(PUBLISHED - 5);
    expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toHaveTextContent('Page · version 2');
    expect(previews(sent)).toEqual([]);

    await until(PUBLISHED + 50);
    expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toHaveTextContent('Page · version 1');
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-page', html: WRITTEN });
  });
});

it("keeps the version a card opened when a saved chat's finished write shows", async () => {
  phone(false);
  const view = render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const posted = sandboxReady(screen.getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'artifact-page', html: PAGE }, '*'));

  // The turn's earlier draft, as a folded Worklog draws its steps when the User opens it.
  const draft = { id: 'w', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ file_path: '/reports/q3.html', content: '<h1>Draft</h1>' }) } };
  const [question, ...answer] = reply();
  if (!question) throw new Error('the reply has no question');
  view.rerender(<Chat messages={[
    question,
    { id: 'd', role: 'assistant' as const, content: '', toolCalls: [draft] },
    { id: 'dt', role: 'tool' as const, toolCallId: 'w', content: 'Updated file /reports/q3.html' },
    ...answer,
  ] as ReturnType<typeof reply>} />);
  await act(async () => {});

  expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toBeInTheDocument();
  expect(posted).toHaveBeenLastCalledWith({ type: 'artifact-page', html: PAGE }, '*');
});
