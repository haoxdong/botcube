// DOMPurify needs a DOM that walks a tree as browsers do: happy-dom stops at the first node it removes.
// @vitest-environment jsdom
import { HttpAgent, type Message } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider, useAgent } from '@copilotkit/react-core/v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { check, describe as describeError } from 'botcube-artifact-check';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { ArtifactLayout } from './artifact-panel';
import { sanitizeSlide } from './slide-sanitize';
// The panel loads the exporter on Download; loading it with the test keeps transforming PptxGenJS out of the test's time.
import './slides-pptx';

const DECK = JSON.stringify({
  v: 4, createdOnFiles: { v: 1, at: '2026-11-11T09:00:00Z' }, lists: 'css', title: 'Q3 Operating Review',
  order: ['cover', 'agenda', 'numbers'], cover: 'cover', faces: {}, designSystems: [],
});
const COVER = '<section id="cover" style="background:#0f2a3d;color:#f4f1ea;padding:128px"><h1 style="font-size:120px">Q3 Operating Review</h1><aside>Open with the number.</aside></section>';
const AGENDA = '<section id="agenda" style="background:#fbfbf8;padding:128px"><h2 style="font-size:72px">Agenda</h2><div style="flex:1;z-index:2" onclick="track()"><p>Numbers</p></div></section>';
const EMBED_PAGE = '<!doctype html><html><body><p id="n"></p><script>n.textContent = "live"</script></body></html>';
const NUMBERS = `<section id="numbers" style="background:#ffffff;padding:128px"><h2>Numbers</h2><x-embed style="position:absolute;left:128px;top:400px;width:800px;height:300px">${EMBED_PAGE}</x-embed></section>`;
const WRITES = [
  ['/decks/q3/project/deck.json', DECK],
  ['/decks/q3/project/slides/cover.html', COVER],
  ['/decks/q3/project/slides/agenda.html', AGENDA],
  ['/decks/q3/project/slides/numbers.html', NUMBERS],
] as const;
const PUBLISHED = {
  id: '/decks/q3', type: 'slides', title: 'Q3 Operating Review', description: 'Where Q3 landed', version: 1,
  path: '/artifacts/decks/q3.versions/1',
};
const VERSION = 'artifacts/decks/q3.versions/1/project';
/** Files holding the published version. */
const STORED: Record<string, string> = {
  [`${VERSION}/deck.json`]: DECK, [`${VERSION}/slides/cover.html`]: COVER, [`${VERSION}/slides/agenda.html`]: AGENDA, [`${VERSION}/slides/numbers.html`]: NUMBERS,
};

/** Files' answers: a signed URL for a stored file, then its text. */
function files(input: string) {
  if (input.startsWith('https://files.test/')) return new Response(STORED[decodeURIComponent(input.slice('https://files.test/'.length))]);
  const name = new URL(input).searchParams.get('name') ?? '';
  return name in STORED ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : Response.json({ detail: `No file named ${name}` }, { status: 404 });
}

type Event = { atMs: number; type: string } & Record<string, unknown>;
const CHUNK = 12;
const STEP_MS = 8;
const RESULT_MS = 40;
// The model writes the next call after a pause.
const PAUSE_MS = 600;

/** A turn that writes the deck, file by file, as deepagents streams write_file, then publishes it. */
function deckTurn(): { events: Event[]; written: number[] } {
  const events: Event[] = [{ atMs: 0, type: 'RUN_STARTED', threadId: 'thread', runId: 'run' }];
  const written: number[] = [];
  let at = 10;
  WRITES.forEach(([path, content], index) => {
    const id = `write-${index}`;
    const args = JSON.stringify({ file_path: path, content });
    events.push({ atMs: at, type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'write_file', parentMessageId: `m-${id}` });
    for (let from = 0; from < args.length; from += CHUNK) {
      at += STEP_MS;
      events.push({ atMs: at, type: 'TOOL_CALL_ARGS', toolCallId: id, delta: args.slice(from, from + CHUNK) });
    }
    events.push({ atMs: at + 1, type: 'TOOL_CALL_END', toolCallId: id });
    at += RESULT_MS;
    events.push({ atMs: at, type: 'TOOL_CALL_RESULT', messageId: `r-${id}`, toolCallId: id, role: 'tool', content: `Updated file ${path}` });
    written.push(at);
    at += PAUSE_MS;
  });
  events.push(
    { atMs: at, type: 'TOOL_CALL_START', toolCallId: 'publish', toolCallName: 'Artifact', parentMessageId: 'm-publish' },
    { atMs: at + 1, type: 'TOOL_CALL_ARGS', toolCallId: 'publish', delta: JSON.stringify({ file_path: '/decks/q3/project/deck.json' }) },
    { atMs: at + 2, type: 'TOOL_CALL_END', toolCallId: 'publish' },
    { atMs: at + 40, type: 'TOOL_CALL_RESULT', messageId: 'r-publish', toolCallId: 'publish', role: 'tool', content: JSON.stringify(PUBLISHED) },
    { atMs: at + 50, type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' },
  );
  return { events, written };
}

const phone = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: matches && query === '(max-width: 640px)', media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);

/** The deck's sandbox page saying it is ready; happy-dom loads no frame, so its window records what the panel posts. */
function sandboxReady(frame: HTMLIFrameElement) {
  expect(frame.getAttribute('src')).toBe('/artifact-sandbox/slides/');
  const posted = vi.fn();
  const sandbox = { postMessage: posted } as unknown as Window;
  Object.defineProperty(frame, 'contentWindow', { value: sandbox, configurable: true });
  void act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'artifact-sandbox-ready' }, origin: 'null', source: sandbox })));
  return posted;
}

type Shown = { id: string; html: string | null; embeds: { style: string; html: string }[] };
type Sent = { at: number; slides: Shown[] };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_ARTIFACTS', '1');
  vi.stubGlobal('matchMedia', vi.fn());
  // jsdom lays nothing out: the resizable panels observe sizes that never change.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('while the agent writes a deck', () => {
  const { events, written } = deckTurn();
  const [DECK_WRITTEN = 0, COVER_WRITTEN = 0, AGENDA_WRITTEN = 0, NUMBERS_WRITTEN = 0] = written;
  const TURN_ENDS = (events.at(-1)?.atMs ?? 0) + 1;

  function Messages() {
    const { agent } = useAgent();
    return <CopilotChatMessageView messages={agent.messages} isRunning={agent.isRunning} />;
  }

  async function startTurn() {
    phone(false);
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input !== 'https://chat.test/agent' ? files(input) : new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { atMs, ...event } of events) setTimeout(() => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)), atMs);
        setTimeout(() => controller.close(), TURN_ENDS);
      },
    }), { headers: { 'content-type': 'text/event-stream' } })));
    const agent = new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread' });
    render(
      <CopilotKitProvider selfManagedAgents={{ default: agent }}>
        <CopilotChatConfigurationProvider threadId="thread">
          <ArtifactLayout agent={agent}><div className="app-chat"><Messages /></div></ArtifactLayout>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>,
    );
    await act(async () => {
      void agent.runAgent();
      await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    });
    const panel = screen.getByRole('region', { name: 'q3' });
    const sent: Sent[] = [];
    sandboxReady(within(panel).getByTitle<HTMLIFrameElement>('q3')).mockImplementation((message: { type: string; slides: Shown[] }) => {
      if (message.type === 'artifact-slides') sent.push({ at: Date.now(), slides: message.slides });
    });
    // Frame by frame, each step after the last one's renders: recursion, not a loop of awaits.
    const until = async (ms: number): Promise<void> => {
      if (Date.now() >= ms) return;
      await act(() => vi.advanceTimersByTimeAsync(Math.min(16, ms - Date.now())));
      return until(ms);
    };
    return { panel, sent, until };
  }

  const shown = (sent: Sent[]) => sent.at(-1)?.slides.map(({ id, html }) => [id, html === null ? 'waiting' : html.includes('</section>') ? 'whole' : 'partial']);

  beforeEach(() => {
    // The clock the stream and the panel run on, and no more: a faked setImmediate stalls Node's streams under the turn.
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the deck beside the chat with a slot for every slide once deck.json is written, then fills the slides one by one', async () => {
    const { sent, until } = await startTurn();

    await until(DECK_WRITTEN + 300);
    expect(shown(sent)).toEqual([['cover', 'waiting'], ['agenda', 'waiting'], ['numbers', 'waiting']]);

    await until(COVER_WRITTEN - RESULT_MS - 2 * STEP_MS);
    expect(shown(sent)).toEqual([['cover', 'partial'], ['agenda', 'waiting'], ['numbers', 'waiting']]);

    await until(COVER_WRITTEN + 300);
    expect(shown(sent)).toEqual([['cover', 'whole'], ['agenda', 'waiting'], ['numbers', 'waiting']]);

    await until(TURN_ENDS + 300);
    expect(shown(sent)).toEqual([['cover', 'whole'], ['agenda', 'whole'], ['numbers', 'whole']]);
    // Never blank once deck.json is in: every message holds every slide, at most four a second.
    const first = sent.findIndex(({ slides }) => slides.length > 0);
    expect(sent.slice(first).every(({ slides }) => slides.length === 3)).toBe(true);
    const times = sent.map(({ at }) => at);
    expect(Math.min(...times.slice(1).map((at, index) => at - (times[index] ?? Number.NaN)))).toBeGreaterThanOrEqual(250);
  });

  it('strips what the slide format has no place for, and lists it under the deck', async () => {
    const { panel, sent, until } = await startTurn();

    await until(AGENDA_WRITTEN + 300);

    const agenda = sent.at(-1)?.slides.find(({ id }) => id === 'agenda');
    expect(agenda?.html).toContain('<h2 style="font-size:72px">Agenda</h2>');
    expect(agenda?.html).not.toMatch(/onclick|z-index/);
    const stripped = within(panel).getByRole('list', { name: 'Not shown: outside the slide format' });
    expect(within(stripped).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'slides/agenda.html: <div> z-index:2',
      'slides/agenda.html: <div onclick>',
    ]);
  });

  it('refuses Download as PowerPoint while the agent writes the deck, and offers the PDF instead', async () => {
    const { panel, until } = await startTurn();

    await until(COVER_WRITTEN + 300);
    await act(async () => within(panel).getByRole('button', { name: 'Download as PowerPoint' }).click());

    const failure = within(panel).getByRole('alert');
    expect(failure).toHaveTextContent("Couldn't make the PowerPoint: the deck is still being written; it downloads once it is published.");
    expect(within(failure).getByRole('button', { name: 'Download as PDF' })).toBeInTheDocument();
  });

  it("previews a slide without its <x-embed> page, and runs it once the publish opens the version", async () => {
    const { sent, until } = await startTurn();

    await until(NUMBERS_WRITTEN + 300);
    const numbers = sent.flatMap(({ slides }) => slides.filter(({ id, html }) => id === 'numbers' && html !== null));
    expect(numbers.at(-1)?.html).toContain('</section>');
    expect(numbers.flatMap(({ embeds }) => embeds)).toEqual([]);

    await until(TURN_ENDS + 300);
    const panel = screen.getByRole('region', { name: 'Q3 Operating Review' });
    expect(panel).toHaveTextContent('Slides · version 1');
    vi.useRealTimers();
    const posted = sandboxReady(within(panel).getByTitle<HTMLIFrameElement>('Q3 Operating Review'));
    await waitFor(() => expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'artifact-slides' }), '*'));
    const { slides } = posted.mock.lastCall?.[0] as { slides: Shown[] };
    expect(slides.find(({ id }) => id === 'numbers')?.embeds).toEqual([
      { style: 'position:absolute;left:128px;top:400px;width:800px;height:300px', html: EMBED_PAGE },
    ]);
  });
});

it("opens a published deck's version from Files, slide by slide in the deck's order", async () => {
  phone(false);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => files(input)));
  const messages = [
    { id: 'u', role: 'user' as const, content: 'Make the Q3 deck' },
    { id: 'a', role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/decks/q3/project/deck.json' }) } }] },
    { id: 't', role: 'tool' as const, toolCallId: 'c', content: JSON.stringify(PUBLISHED) },
  ];
  render(
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread' })}><div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div></ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>,
  );

  const card = await screen.findByRole('button', { name: /Q3 Operating Review/ });
  expect(card).toHaveTextContent('Slides · version 1');
  await userEvent.click(card);
  const posted = sandboxReady(screen.getByTitle<HTMLIFrameElement>('Q3 Operating Review'));

  await waitFor(() => expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'artifact-slides' }), '*'));
  const { slides } = posted.mock.lastCall?.[0] as { slides: Shown[] };
  expect(slides.map(({ id }) => id)).toEqual(['cover', 'agenda', 'numbers']);
  expect(slides[0]?.html).toContain('Q3 Operating Review</h1>');
  expect(slides[2]?.embeds).toHaveLength(1);
});

it("shows an error, not an empty deck, when the published deck.json does not parse", async () => {
  phone(false);
  const broken: Record<string, string> = { ...STORED, [`${VERSION}/deck.json`]: '{"title": "Q3", "order": [' };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('https://files.test/')) return new Response(broken[decodeURIComponent(input.slice('https://files.test/'.length))]);
    return files(input);
  }));
  const messages = [
    { id: 'u', role: 'user' as const, content: 'Make the Q3 deck' },
    { id: 'a', role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/decks/q3/project/deck.json' }) } }] },
    { id: 't', role: 'tool' as const, toolCallId: 'c', content: JSON.stringify(PUBLISHED) },
  ];
  render(
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread' })}><div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div></ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>,
  );

  await userEvent.click(await screen.findByRole('button', { name: /Q3 Operating Review/ }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open Q3 Operating Review: its deck.json does not parse as a deck");
});

it('keeps the attributes a shape and an svg chart draw with, an image held in the slide, and a link as its text', () => {
  const photo = 'data:image/png;base64,iVBORw0KGgo=';
  const slide = [
    '<section id="mix">',
    '<x-shape kind="ellipse" style="width:200px;height:200px;background:#1d4ed8"></x-shape>',
    '<svg viewBox="0 0 100 50" width="400" height="200" fill="none"><path d="M0 50 L50 10 L100 30" stroke="#1d4ed8" stroke-width="2"></path>',
    '<rect x="10" y="20" width="30" height="30" fill="#f59e0b"></rect></svg>',
    `<p><a href="https://example.com/q3">Q3 report</a> <a href="javascript:alert(1)">Bad link</a></p><img alt="" src="${photo}"><img alt="" src="/_blob/x">`,
    '</section>',
  ].join('');

  const { html, stripped } = sanitizeSlide('slides/mix.html', slide);

  expect(html).toContain('<x-shape kind="ellipse"');
  expect(html).toContain('d="M0 50 L50 10 L100 30"');
  expect(html).toContain('stroke="#1d4ed8"');
  expect(html).toContain('<rect x="10" y="20" width="30" height="30" fill="#f59e0b">');
  expect(html).toContain('<svg viewBox="0 0 100 50" width="400" height="200" fill="none">');
  expect(html).toContain(`<img alt="" src="${photo}">`);
  // A slide has no navigation: its links keep their text and lose their href, which the format allows.
  expect(html).toContain('<a>Q3 report</a> <a>Bad link</a>');
  expect(html).not.toContain('href');
  expect(stripped).toEqual(['slides/mix.html: <img src>']);
});

/** What an svg chart holds, inside `<svg viewBox="0 0 100 50">`, and whether the slide format allows it. */
const SVG_CASES: { inner: string; allowed: boolean; refused?: string }[] = [
  { inner: '<rect x="1" y="2" width="10" height="20" rx="2" fill="#1d4ed8"></rect>', allowed: true },
  { inner: '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"></stop></linearGradient></defs><path d="M0 0 L10 10" fill="url(#g)"></path>', allowed: true },
  { inner: '<g transform="translate(4 4)"><circle cx="5" cy="5" r="4" class="dot" data-series="a"></circle><text x="1" y="9" font-size="4" text-anchor="start">Q3</text></g>', allowed: true },
  { inner: '<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"></image>', allowed: false, refused: '<svg> <image>' },
  { inner: '<use href="#dot"></use>', allowed: false, refused: '<svg> <use>' },
  { inner: '<rect width="10" height="10"><animate attributeName="x" to="40" dur="1s"></animate></rect>', allowed: false, refused: '<svg> <animate>' },
  { inner: '<foreignObject width="10" height="10"></foreignObject>', allowed: false, refused: '<svg> <foreignObject>' },
  { inner: '<rect width="10" height="10" style="fill:red"></rect>', allowed: false, refused: '<rect style>' },
  { inner: '<rect width="10" height="10" onclick="track()"></rect>', allowed: false, refused: '<rect onclick>' },
  { inner: '<path d="M0 0" filter="blur(2px)"></path>', allowed: false, refused: '<path filter>' },
];

describe('the checker refuses on publish what the sanitizer would strip from an svg chart, from the one allowlist', () => {
  const deck = JSON.stringify({ title: 'Charts', order: ['chart'] });
  it.each(SVG_CASES)('$inner', async ({ inner, allowed, refused }) => {
    const slide = `<section id="chart" style="background:#ffffff"><svg viewBox="0 0 100 50" width="400" height="200">${inner}</svg></section>`;

    const errors = await check('slides', { 'project/deck.json': deck, 'project/slides/chart.html': slide });
    const { stripped } = sanitizeSlide('slides/chart.html', slide);

    expect(errors.map(describeError)).toEqual(allowed ? [] : [expect.stringContaining(` ${refused} — `)]);
    expect(stripped.length > 0).toBe(!allowed);
  });
});

describe("the User's edit of a published deck's text", () => {
  const VALID_COVER = '<section id="cover" style="background:#0f2a3d;color:#f4f1ea;padding:128px;display:flex;flex-direction:column;gap:32px"><h1 style="font-size:120px;font-weight:600">Q3 Operating Review</h1><p style="font-size:32px">Where we landed</p><aside>Open with the number.</aside></section>';
  const VALID_AGENDA = '<section id="agenda" style="background:#fbfbf8;padding:128px;display:flex;flex-direction:column;gap:48px"><h2 style="font-size:72px">Agenda</h2><ul><li>Numbers</li><li>Risks</li></ul></section>';
  const VALID_DECK = JSON.stringify({ ...JSON.parse(DECK), order: ['cover', 'agenda'], sections: { s1: { description: 'Where Q3 landed', start: 'cover' } } });
  const V1 = 'artifacts/decks/q3.versions/1/project';
  const V2 = 'artifacts/decks/q3.versions/2/project';
  type Save = { id: string; version: number; files: Record<string, string> };

  // jsdom lays nothing out; ProseMirror asks where the caret is after each keystroke.
  beforeEach(() => {
    const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Object.defineProperty(Range.prototype, 'getClientRects', { value: rects, configurable: true });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: () => new DOMRect(), configurable: true });
    Object.defineProperty(Text.prototype, 'getClientRects', { value: rects, configurable: true });
    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
  });

  function deckInFiles(agenda = VALID_AGENDA, answer?: Response) {
    const stored: Record<string, string> = { [`${V1}/deck.json`]: VALID_DECK, [`${V1}/slides/cover.html`]: VALID_COVER, [`${V1}/slides/agenda.html`]: agenda };
    const saves: Save[] = [];
    // As the Chat Service stores a save: the next version beside its record, refused over any newer version.
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('https://files.test/')) return new Response(stored[decodeURIComponent(input.slice('https://files.test/'.length))]);
      if (new URL(input).pathname === '/files/artifact-save') {
        const save = JSON.parse(init?.body as string) as Save;
        saves.push(save);
        if (answer) return answer;
        const next = save.version + 1;
        const version = (number: number) => `artifacts/decks/q3.versions/${number}`;
        if (`${version(next)}/project/deck.json` in stored) return Response.json({ detail: `Version ${next} of /decks/q3 is newer than the version ${save.version} you edited.` }, { status: 409 });
        for (const name of ['deck.json', 'slides/cover.html', 'slides/agenda.html']) stored[`${version(next)}/project/${name}`] = stored[`${version(save.version)}/project/${name}`] ?? '';
        for (const [name, text] of Object.entries(save.files)) stored[`${version(next)}/${name}`] = text;
        stored[`${version(next)}.json`] = JSON.stringify({ author: 'user', title: PUBLISHED.title, description: PUBLISHED.description });
        return Response.json({ ...PUBLISHED, version: next, author: 'user', path: `/${version(next)}` });
      }
      const name = new URL(input).searchParams.get('name') ?? '';
      return name in stored ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : Response.json({ detail: `No file named ${name}` }, { status: 404 });
    }));
    return { stored, saves };
  }

  const published = (call: string, artifact: object) => [
    { id: `a-${call}`, role: 'assistant' as const, content: '', toolCalls: [{ id: call, type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/decks/q3/project/deck.json' }) } }] },
    { id: `t-${call}`, role: 'tool' as const, toolCallId: call, content: JSON.stringify(artifact) },
  ];

  async function openDeck() {
    phone(false);
    const agent = new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread' });
    const chat = (messages: Message[]) => (
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider threadId="thread">
          <ArtifactLayout agent={agent}><div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div></ArtifactLayout>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    );
    const first = [{ id: 'u', role: 'user' as const, content: 'Make the Q3 deck' }, ...published('c', PUBLISHED)];
    const { rerender, unmount } = render(chat(first));
    await userEvent.click(await screen.findByRole('button', { name: /Q3 Operating Review/ }));
    const panel = screen.getByRole('region', { name: 'Q3 Operating Review' });
    const posted = sandboxReady(within(panel).getByTitle<HTMLIFrameElement>('Q3 Operating Review'));
    await waitFor(() => expect(posted).toHaveBeenCalled());
    const agentPublishes = (artifact: object) => rerender(chat([...first, ...published('c2', artifact)]));
    return { panel, posted, agentPublishes, unmount };
  }

  async function editCover(panel: HTMLElement, typed: string) {
    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));
    type(within(within(panel).getByRole('group', { name: 'Slide 1: cover' })).getByRole('textbox', { name: 'Paragraph 1' }));
    await userEvent.keyboard(typed);
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));
  }

  it('saves the edited slide as the next version, saved by you, and the deck shows it', async () => {
    const { saves, stored } = deckInFiles();
    const { panel, posted } = await openDeck();

    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));
    const cover = within(panel).getByRole('group', { name: 'Slide 1: cover' });
    type(within(cover).getByRole('textbox', { name: 'Paragraph 1' }));
    await userEvent.keyboard('Checked: ');
    await waitFor(() => expect(lastSlides(posted)[0]?.html).toContain('Checked: Where we landed</p>'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(panel).getByText('Slides · version 2 · saved by you')).toBeVisible());
    expect(saves).toEqual([{ id: '/decks/q3', version: 1, files: { 'project/slides/cover.html': VALID_COVER.replace('Where we landed</p>', 'Checked: Where we landed</p>') } }]);
    expect(stored[`${V2}/slides/cover.html`]).toContain('<aside>Open with the number.</aside>');
    expect(within(panel).queryByRole('button', { name: 'Save' })).toBeNull();
    await waitFor(() => expect(lastSlides(posted)[0]?.html).toContain('Checked: Where we landed'));
  });

  it("opens the User's saved version after the chat reloads with only the agent's publish, and saves over it", async () => {
    const { stored, saves } = deckInFiles();
    const first = await openDeck();
    await editCover(first.panel, 'Saved: ');
    await waitFor(() => expect(within(first.panel).getByText('Slides · version 2 · saved by you')).toBeVisible());
    first.unmount();

    const { panel, posted } = await openDeck();

    await waitFor(() => expect(within(panel).getByText('Slides · version 2 · saved by you')).toBeVisible());
    await waitFor(() => expect(lastSlides(posted)[0]?.html).toContain('Saved: Where we landed'));
    await editCover(panel, 'Again: ');
    await waitFor(() => expect(within(panel).getByText('Slides · version 3 · saved by you')).toBeVisible());
    expect(saves.map(({ version }) => version)).toEqual([1, 2]);
    expect(stored[`${V2.replace('/2/', '/3/')}/slides/cover.html`]).toContain('Again: Saved: Where we landed');
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('offers the text to edit, not the layout: no element can be moved or resized', async () => {
    deckInFiles();
    const { panel } = await openDeck();

    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));

    const boxes = within(panel).getAllByRole('textbox').map((box) => box.getAttribute('aria-label'));
    expect(boxes).toEqual(['Heading 1', 'Paragraph 1', 'Heading 1', 'List item 1', 'List item 2']);
    expect(panel.querySelectorAll('[draggable="true"], [data-resize-handle], [role="slider"]')).toHaveLength(0);
    expect(within(panel).queryByRole('button', { name: /move|resize|position|size/i })).toBeNull();
  });

  it("keeps the User's edit and says why when the save is refused", async () => {
    deckInFiles(VALID_AGENDA, Response.json({ detail: 'Version 2 of /decks/q3 is newer than the version 1 you edited. Open the newest and edit again.' }, { status: 409 }));
    const { panel } = await openDeck();

    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));
    type(within(panel).getAllByRole('textbox')[0] as HTMLElement);
    await userEvent.keyboard('Draft: ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent("Couldn't save: Version 2 of /decks/q3 is newer than the version 1 you edited. Open the newest and edit again.");
    expect(within(panel).getAllByRole('textbox')[0]).toHaveTextContent('Draft: Q3 Operating Review');
    expect(within(panel).getByText('Slides · version 1')).toBeVisible();
  });

  it("keeps the User's draft on the version they edit when the agent publishes a newer one, until they discard it", async () => {
    const { stored, saves } = deckInFiles();
    const { panel, posted, agentPublishes } = await openDeck();
    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));
    type(within(within(panel).getByRole('group', { name: 'Slide 1: cover' })).getByRole('textbox', { name: 'Paragraph 1' }));
    await userEvent.keyboard('Draft: ');
    for (const name of ['deck.json', 'slides/cover.html']) stored[`${V2}/${name}`] = stored[`${V1}/${name}`] ?? '';
    stored[`${V2}/slides/agenda.html`] = VALID_AGENDA.replace('Risks', 'Risks and asks');

    agentPublishes({ ...PUBLISHED, version: 2, path: '/artifacts/decks/q3.versions/2' });

    const newer = await within(panel).findByRole('status');
    expect(newer).toHaveTextContent('Version 2 arrived while you edited version 1. Your edits are kept.');
    expect(within(panel).getByRole('textbox', { name: 'Paragraph 1' })).toHaveTextContent('Draft: Where we landed');
    await waitFor(() => expect(lastSlides(posted)[0]?.html).toContain('Draft: Where we landed'));
    expect(saves).toEqual([]);

    await userEvent.click(within(newer).getByRole('button', { name: 'Discard edits and open version 2' }));

    await waitFor(() => expect(lastSlides(posted)[1]?.html).toContain('Risks and asks'));
    expect(lastSlides(posted)[0]?.html).not.toContain('Draft:');
    expect(within(panel).queryByRole('status')).toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull();
    expect(within(panel).getByText('Slides · version 2')).toBeVisible();
  });

  it('downloads the version the User is editing as a PowerPoint, without their unsaved edits, when the agent publishes a newer one', async () => {
    const { stored } = deckInFiles();
    const saved = browserDownloads();
    const { panel, agentPublishes } = await openDeck();
    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));
    type(within(within(panel).getByRole('group', { name: 'Slide 1: cover' })).getByRole('textbox', { name: 'Paragraph 1' }));
    await userEvent.keyboard('Draft: ');
    for (const name of ['deck.json', 'slides/cover.html']) stored[`${V2}/${name}`] = stored[`${V1}/${name}`] ?? '';
    stored[`${V2}/slides/agenda.html`] = VALID_AGENDA.replace('Risks', 'Risks and asks');
    agentPublishes({ ...PUBLISHED, version: 2, path: '/artifacts/decks/q3.versions/2' });
    await within(panel).findByRole('status');

    expect(within(panel).getByText('The PowerPoint is version 1, without your unsaved edits')).toBeVisible();
    await userEvent.click(within(panel).getByRole('button', { name: 'Download as PowerPoint' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const [blob] = saved;
    if (blob === undefined) throw new Error('No PowerPoint was saved');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const slide = async (number: number) => await zip.file(`ppt/slides/slide${number}.xml`)?.async('string') ?? '';
    expect(await slide(1)).toContain('<a:t>Where we landed</a:t>');
    expect(await slide(1)).not.toContain('Draft:');
    expect(await slide(2)).toContain('<a:t>Risks</a:t>');
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('shows each error of a save the Files service refuses, and keeps the draft to fix', async () => {
    const refusal = 'project/slides/agenda.html:1:5 <div> z-index: 2 is not allowed. Nearest: z-index: 0 or 1\nproject/slides/agenda.html:2:1 <div onclick> handlers are not allowed. Nearest: no handler';
    deckInFiles(AGENDA, Response.json({ detail: refusal }, { status: 400 }));
    const { panel } = await openDeck();

    await userEvent.click(within(panel).getByRole('button', { name: 'Edit text' }));
    type(within(panel).getAllByRole('textbox')[0] as HTMLElement);
    await userEvent.keyboard('Final ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    const alerts = (await within(panel).findAllByRole('alert')).map((alert) => alert.textContent);
    expect(alerts).toEqual(expect.arrayContaining([expect.stringMatching(/agenda\.html:1:5 <div> z-index: 2/), expect.stringMatching(/<div onclick>/)]));
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeVisible();
  });
});

/** Puts the caret in an editor; a click would land on the resize handle, which jsdom lays out over everything. */
function type(box: HTMLElement) {
  act(() => box.focus());
}

/** The files the browser saves from a download link's click; jsdom has no object URLs and follows no download. */
function browserDownloads() {
  const saved: Blob[] = [];
  const urls = new Map<string, Blob>();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => {
    const url = `blob:${location.origin}/${urls.size}`;
    urls.set(url, blob);
    return url;
  } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => urls.delete(url) });
  const download = (event: MouseEvent) => {
    const link = event.target;
    if (!(link instanceof HTMLAnchorElement) || !link.hasAttribute('download')) return;
    event.preventDefault();
    const blob = urls.get(link.href);
    if (blob !== undefined) saved.push(blob);
  };
  document.addEventListener('click', download);
  onTestFinished(() => {
    document.removeEventListener('click', download);
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });
  return saved;
}

function lastSlides(posted: ReturnType<typeof vi.fn>): Shown[] {
  return (posted.mock.lastCall?.[0] as { slides: Shown[] } | undefined)?.slides ?? [];
}
