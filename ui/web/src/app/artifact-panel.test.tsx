import { HttpAgent } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider, useAgent } from '@copilotkit/react-core/v2';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactLayout } from './artifact-panel';
import { publishedOf } from './artifact-published';
import recorded from './artifact-live-fill.stream.json';
import MarkdownRenderer from './markdown-renderer';
import { PHONE_QUERY } from './phone-query';

const PAGE = '<!doctype html><html><head><title>Q3 revenue</title></head><body><h1>Q3</h1></body></html>';
const PUBLISHED = {
  id: '/reports/q3.html', type: null, title: 'Q3 revenue by month', description: 'Monthly revenue against plan',
  version: 2, path: '/artifacts/reports/q3.html.versions/2.html',
};
const PAGE_1 = PAGE.replace('<h1>Q3</h1>', '<h1>Q3 draft</h1>');

/** The chat's agent when no turn runs: these chats show saved messages. */
const IDLE = new HttpAgent({ url: 'https://chat.test/agent' });

const reply = (result: string = JSON.stringify(PUBLISHED), turn = '') => [
  { id: `u${turn}`, role: 'user' as const, content: 'Chart Q3 revenue' },
  {
    id: `a${turn}`, role: 'assistant' as const, content: '',
    toolCalls: [{ id: `c${turn}`, type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/reports/q3.html', title: PUBLISHED.title }) } }],
  },
  { id: `t${turn}`, role: 'tool' as const, toolCallId: `c${turn}`, content: result },
];

function Chat({ messages = reply(), accountId = "pane-test" }: { messages?: ReturnType<typeof reply>; accountId?: string }) {
  return (
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={IDLE} accountId={accountId}>
          <div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div>
        </ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

/** Version `n`'s record, `<n>.json` beside it: the agent published it. */
const record = (n: number) => JSON.stringify({ author: 'agent', title: PUBLISHED.title, description: `${PUBLISHED.description} ${n}` });

function files() {
  const fetchImpl = vi.fn(async (input: string) => {
    // The versions' records, for the panel's history; listing no version's page keeps the chat's newest the newest.
    if (new URL(input).pathname === '/files') return Response.json({ files: [1, 2].map((version) => ({ name: `artifacts/reports/q3.html.versions/${version}.json`, size: 1, lastModified: '2026-11-15T18:00:00Z' })) });
    if (input === 'https://files.test/2.html') return new Response(PAGE);
    if (input === 'https://files.test/1.html') return new Response(PAGE_1);
    if (input === 'https://files.test/2.json') return new Response(record(2));
    if (input === 'https://files.test/1.json') return new Response(record(1));
    const name = new URL(input).searchParams.get('name');
    const [, version, kind] = /^artifacts\/reports\/q3\.html\.versions\/([12])\.(html|json)$/.exec(name ?? '') ?? [];
    return version
      ? Response.json({ url: `https://files.test/${version}.${kind}` })
      : Response.json({ detail: `No file named ${name}` }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchImpl);
}

function phone(matches: boolean) {
  let isPhone = matches;
  const listeners = new Set<() => void>();
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    get matches() { return isPhone && query === PHONE_QUERY; },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }) as unknown as MediaQueryList);
  return (phoneNow: boolean) => act(() => {
    isPhone = phoneNow;
    for (const listener of listeners) listener();
  });
}

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

/**
 * The text of the version the panel's history menu marks Current, read by opening the menu and closing it again.
 * `until` waits for a check to pass; under fake timers, where `waitFor` stalls, it moves the clock instead.
 */
async function currentVersion(panel: HTMLElement, until: <T>(check: () => T) => Promise<T> = (check) => waitFor(check)) {
  await act(() => within(panel).getByRole('button', { name: /^Edited by/ }).click());
  const item = await until(() => {
    const found = screen.getAllByRole('menuitem').find((menuitem) => menuitem.textContent.includes('Current'));
    if (!found) throw new Error('no version is marked Current');
    return found;
  });
  const text = item.textContent;
  await act(() => fireEvent.keyDown(item, { key: 'Escape' }));
  await until(() => expect(screen.queryByRole('menu')).toBeNull());
  return text;
}

beforeEach(files);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows a published Artifact as a card with only its title and Type", async () => {
  phone(false);
  render(<Chat />);

  const card = await screen.findByRole('button', { name: /Q3 revenue by month/ });
  expect(card).toHaveTextContent('Q3 revenue by monthPage');
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
  expect(frame).toHaveAttribute('src', '/artifact-sandbox/index.html');
  const posted = sandboxReady(frame);
  await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'artifact-page', position: { left: 0, top: 0 }, html: PAGE }, '*'));

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

it('slides the phone sheet in from its starting style on the first open too', async () => {
  phone(true);
  render(<Chat />);
  const card = await screen.findByRole('button', { name: /Q3 revenue by month/ });
  // The sheet's CSS slides it up from `[data-starting-style]`; a sheet that never had it paints in place.
  let started = false;
  const observer = new MutationObserver(() => { started ||= document.querySelector('.artifact-sheet[data-starting-style]') !== null; });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-starting-style'] });
  await userEvent.click(card);
  await screen.findByRole('dialog', { name: 'Q3 revenue by month' });
  observer.disconnect();

  expect(started).toBe(true);
});

it('prints the page as shown for Download as PDF', async () => {
  phone(false);
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const posted = sandboxReady(screen.getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));

  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'PDF' }));

  expect(posted).toHaveBeenLastCalledWith({ type: 'artifact-print' }, '*');
});

it("lists the Page's formats in one Download menu and downloads its stored Source as .html", async () => {
  phone(false);
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const saved: { blob: Blob; name: string }[] = [];
  let made: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    made = blob as Blob;
    return 'blob:page';
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (made !== undefined) saved.push({ blob: made, name: this.download });
  });

  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect((await screen.findAllByRole('menuitem')).map(({ textContent }) => textContent)).toEqual(['Web page (.html)', 'PDF']);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Web page (.html)' }));

  await waitFor(() => expect(saved).toHaveLength(1));
  const [{ blob, name }] = saved as [{ blob: Blob; name: string }];
  expect(name).toBe('Q3 revenue by month.html');
  expect(blob.type).toBe('text/html');
  expect(await blob.text()).toBe(PAGE);
});

it('switches an open panel to the new version when the agent publishes an update, and an older card opens the latest', async () => {
  phone(false);
  const first = { ...PUBLISHED, version: 1, path: '/artifacts/reports/q3.html.versions/1.html' };
  const view = render(<Chat messages={reply(JSON.stringify(first))} />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const posted = sandboxReady(screen.getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'artifact-page', position: { left: 0, top: 0 }, html: PAGE_1 }, '*'));

  view.rerender(<Chat messages={[...reply(JSON.stringify(first)), ...reply(JSON.stringify(PUBLISHED), '2')]} />);

  const panel = screen.getByRole('region', { name: 'Q3 revenue by month' });
  const updated = sandboxReady(within(panel).getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(updated).toHaveBeenCalledWith({ type: 'artifact-page', position: { left: 0, top: 0 }, html: PAGE }, '*'));

  await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
  const [older] = screen.getAllByRole('button', { name: /Q3 revenue by month/ });
  if (!older) throw new Error('the first card is gone');
  await userEvent.click(older);
  expect(await currentVersion(screen.getByRole('region', { name: 'Q3 revenue by month' }))).toContain('Version 2');
});

it('shows a read or a list of Artifacts as a line of the reply, not as a card or an error', async () => {
  phone(false);
  const call = (id: string, args: object, result: object) => [
    { id: `a-${id}`, role: 'assistant' as const, content: '', toolCalls: [{ id, type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify(args) } }] },
    { id: `t-${id}`, role: 'tool' as const, toolCallId: id, content: JSON.stringify(result) },
  ];
  render(<Chat messages={[
    { id: 'u', role: 'user' as const, content: 'Update the dashboard you made yesterday' },
    ...call('list', { action: 'list' }, { artifacts: [{ ...PUBLISHED, author: 'agent', read: 2 }] }),
    ...call('read', { action: 'read', url: PUBLISHED.id }, { ...PUBLISHED, author: 'agent', read: 2, html: PAGE, versions: [] }),
  ] as ReturnType<typeof reply>} />);

  expect(await screen.findByText('Listed Artifacts')).toBeInTheDocument();
  expect(screen.getByText('Read /reports/q3.html')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Q3 revenue by month/ })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it("leaves a refused publish's message to its Worklog step, out of the chat", async () => {
  phone(false);
  render(<Chat messages={reply("Error invoking tool 'Artifact' with kwargs {}: No file at /reports/q3.html. Write the page there, then publish it.")} />);

  expect(await screen.findByText('Chart Q3 revenue')).toBeVisible();
  expect(screen.queryByText(/No file at \/reports\/q3\.html/)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
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

  type Recorded = { atMs: number } & Record<string, unknown>;
  const TURN: readonly Recorded[] = recorded.events;
  const at = (type: string, toolCallId: string) => {
    const event = TURN.find((candidate) => candidate.type === type && candidate.toolCallId === toolCallId);
    if (event === undefined) throw new Error(`The recorded turn has no ${type} for ${toolCallId}`);
    return event.atMs;
  };
  const WRITE_ENDS = at('TOOL_CALL_END', 'write');
  const REPUBLISHED = at('TOOL_CALL_RESULT', 'republish');
  const TURN_ENDS = TURN.at(-1)?.atMs ?? Number.NaN;

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
      'artifacts/reports/q3.html.versions/1.json': record(1),
      'artifacts/reports/q3.html.versions/2.json': record(2),
    };
    // Files lists the versions' records, for the panel's history; no version shows newer than the chat's.
    const listed = Object.keys(files).filter((name) => name.endsWith('.json')).map((name) => ({ name, size: 1, lastModified: '1970-01-01T00:00:00Z' }));
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === 'https://chat.test/agent') return new Response(turnStream(events), { headers: { 'content-type': 'text/event-stream' } });
      if (new URL(input).pathname === '/files') return Response.json({ files: listed });
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
    // The clock the stream and the panel run on, and no more: a faked setImmediate stalls Node's streams under the turn.
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the panel closed throughout creation and version updates until a card click', async () => {
    const { sent, until, run } = chat();
    await run();
    await until(WRITE_ENDS - 5);
    expect(screen.queryByRole('region')).toBeNull();
    await until(TURN_ENDS + 10);
    expect(screen.queryByRole('region')).toBeNull();
    expect(sent).toEqual([]);
    await act(() => screen.getAllByRole('button', { name: /Q3 revenue by month/ })[0]?.click());
    await until(TURN_ENDS + 100);
    let at = TURN_ENDS + 100;
    const later = async <T,>(check: () => T) => {
      await until(at += 100);
      return check();
    };
    expect(await currentVersion(screen.getByRole('region', { name: 'Q3 revenue by month' }), later)).toContain('Version 2');
  });

  it('keeps another Artifact open while the Turn creates and updates an Artifact', async () => {
    const other = { ...PUBLISHED, id: '/other.html', title: 'Other dashboard' };
    const { until, run } = chat(TURN, reply(JSON.stringify(other)));
    await until(16);
    await act(() => screen.getByRole('button', { name: /Other dashboard/ }).click());
    await until(100);
    const panel = screen.getByRole('region', { name: 'Other dashboard' });
    const frame = within(panel).getByTitle('Other dashboard');
    await run();
    await until(TURN_ENDS + 100);
    expect(screen.getByRole('region', { name: 'Other dashboard' })).toBe(panel);
    expect(within(panel).getByTitle('Other dashboard')).toBe(frame);
    expect(screen.queryByRole('region', { name: 'Q3 revenue by month' })).toBeNull();
  });

  it("keeps a card's version open while the agent writes its Source, until the publish opens the new version", async () => {
    // The saved chat's card is version 1; the turn publishes version 1 again (no newer version), then version 2.
    const first = { ...PUBLISHED, version: 1, path: '/artifacts/reports/q3.html.versions/1.html' };
    const { sent, until, run } = chat(TURN, reply(JSON.stringify(first)));
    await until(16);
    await act(() => screen.getByRole('button', { name: /Q3 revenue by month/ }).click());
    await until(100);
    expect(sent.map(({ message }) => message)).toEqual([{ type: 'artifact-page', position: { left: 0, top: 0 }, html: WRITTEN }]);
    const panel = screen.getByRole('region', { name: 'Q3 revenue by month' });
    panel.scrollTop = 120;
    await run();

    await until(REPUBLISHED - 5);
    expect(previews(sent)).toEqual([]);
    expect(pages(sent)).toHaveLength(1);

    await until(REPUBLISHED + 50);
    expect(screen.getByRole('region', { name: 'Q3 revenue by month' })).toBe(panel);
    expect(panel.scrollTop).toBe(120);
    expect(sent.at(-1)?.message).toEqual({ type: 'artifact-page', position: { left: 0, top: 0 }, html: EDITED });
  });


});

it("keeps the version a card opened when a saved chat's finished write shows", async () => {
  phone(false);
  const view = render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const posted = sandboxReady(screen.getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'artifact-page', position: { left: 0, top: 0 }, html: PAGE }, '*'));

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
  expect(posted).toHaveBeenLastCalledWith({ type: 'artifact-page', position: { left: 0, top: 0 }, html: PAGE }, '*');
});

it("keeps the chat's version open and says why when Files can't say whether a newer one is stored", async () => {
  phone(false);
  const stored = fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new URL(input).pathname === '/files'
    ? Response.json({ detail: 'Files is unavailable' }, { status: 503 })
    : stored(input)));
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));

  const panel = screen.getByRole('region', { name: 'Q3 revenue by month' });
  expect(await within(panel).findByRole('alert')).toHaveTextContent("Couldn't look for a newer version in Files: Files is unavailable");
  const posted = sandboxReady(within(panel).getByTitle<HTMLIFrameElement>('Q3 revenue by month'));
  await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'artifact-page', position: { left: 0, top: 0 }, html: PAGE }, '*'));
});

it.each([
  ['doc', 'Doc', 'file-text'], ['slides', 'Slides', 'monitor'], ['sheet', 'Sheet', 'table-2'],
  ['email', 'Email', 'mail'], [null, 'Page', 'globe'],
])('shows the %s Artifact with a type icon and Type word', async (type, label, icon) => {
  render(<Chat messages={reply(JSON.stringify({ ...PUBLISHED, type }))} />);
  const card = await screen.findByRole('button', { name: /Q3 revenue by month/ });
  expect(card).toHaveTextContent(`Q3 revenue by month${label}`);
  expect(card.querySelector(`.lucide-${icon}`)).toBeInTheDocument();
});

it('defaults left, moves both ways without remounting, and remembers this User’s side across reloads', async () => {
  phone(false);
  localStorage.removeItem("botcube.artifact-side.pane-test");
  const view = render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  const frame = screen.getByTitle('Q3 revenue by month');
  const chat = view.container.querySelector('.app-chat');
  expect(view.container.querySelector('.artifact-layout')).toHaveAttribute('data-side', 'left');
  await userEvent.click(screen.getByRole('button', { name: 'Move panel to right' }));
  expect(view.container.querySelector('.artifact-layout')).toHaveAttribute('data-side', 'right');
  expect(screen.getByTitle('Q3 revenue by month')).toBe(frame);
  expect(view.container.querySelector('.app-chat')).toBe(chat);
  await userEvent.click(screen.getByRole('button', { name: 'Move panel to left' }));
  expect(view.container.querySelector('.artifact-layout')).toHaveAttribute('data-side', 'left');
  await userEvent.click(screen.getByRole('button', { name: 'Move panel to right' }));
  view.unmount();
  const reload = render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  expect(reload.container.querySelector('.artifact-layout')).toHaveAttribute('data-side', 'right');
  reload.unmount();
  const other = render(<Chat accountId="another-user" />);
  await userEvent.click(await screen.findByRole('button', { name: /Q3 revenue by month/ }));
  expect(other.container.querySelector('.artifact-layout')).toHaveAttribute('data-side', 'left');
});

it.each([true, false])('keeps the chat mounted, with its draft, when the window crosses the phone breakpoint (from a phone: %s)', async (startsAsPhone) => {
  const resize = phone(startsAsPhone);
  const mounted = vi.fn();
  function Composer() {
    useEffect(mounted, []);
    return <textarea aria-label="Ask anything" />;
  }
  render(
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={IDLE} accountId="breakpoint-test">
          <div className="app-chat"><Composer /></div>
        </ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>,
  );
  const box = screen.getByRole('textbox', { name: 'Ask anything' });
  await userEvent.type(box, 'my draft');
  resize(!startsAsPhone);
  expect(screen.getByRole('textbox', { name: 'Ask anything' })).toBe(box);
  expect(box).toHaveValue('my draft');
  resize(startsAsPhone);
  expect(screen.getByRole('textbox', { name: 'Ask anything' })).toHaveValue('my draft');
  expect(mounted).toHaveBeenCalledTimes(1);
});
