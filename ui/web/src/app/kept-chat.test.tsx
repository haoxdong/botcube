import type { Message } from '@ag-ui/client';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { KeptChat } from './kept-chat';

const messages: Message[] = [
  { id: 'm1', role: 'user', content: 'Where did rates close?' },
  { id: 'm2', role: 'assistant', content: '## Rates recap\n\nThe **10y** closed at 4.12%.' },
  { id: 'm3', role: 'tool', toolCallId: 'call-1', content: '{"close":4.12}' },
];

// Like a ResizeObserver: each observer reports when a test says its element resized.
const observed = new Map<Element, ResizeObserverCallback>();
const resize = (element: Element) => act(() => observed.get(element)?.([], {} as ResizeObserver));

beforeEach(() => {
  observed.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: Element) {
      observed.set(element, this.callback);
    }
    disconnect() {
      for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element);
    }
  });
});

const renderKept = () => {
  const view = render(<KeptChat messages={messages} disclaimer="Check important info." composerAccessory={<span>Signed out</span>} />);
  const list = view.container.querySelector('.copilotKitMessages');
  if (list === null) throw new Error('no message list');
  const content = list.closest('[style*="padding-bottom"]');
  if (!(content instanceof HTMLElement)) throw new Error('no padded content');
  const scroller = content.closest('[style*="overflow: auto"]');
  if (!(scroller instanceof HTMLElement)) throw new Error('no scroller');
  return { view, list, content, scroller };
};

const turns = (length: number): Message[] => Array.from({ length }, (_, index) => index % 2 === 0
  ? { id: `m${index}`, role: 'user', content: `Question ${index}` }
  : { id: `m${index}`, role: 'assistant', content: `Answer ${index}` });

// Its layout effect runs after the kept chat's, in the same commit, before any update the kept chat makes.
function AfterKeptChat({ read }: { read: () => void }) {
  useLayoutEffect(() => read(), []);
  return null;
}

it("shows the user's questions as they are and the replies formatted, and no tool results", async () => {
  const { list } = renderKept();

  expect([...list.children].map((row) => row.className.split(' ').slice(0, 2).join(' '))).toEqual([
    'copilotKitMessage copilotKitUserMessage',
    'copilotKitMessage copilotKitAssistantMessage',
  ]);
  expect(list.children[0]).toHaveTextContent('Where did rates close?');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Rates recap' })).toBeInTheDocument());
  expect(list.textContent).not.toMatch(/\*\*|##/);
  expect(list).not.toHaveTextContent('4.12}');
});

it('shows only recent history while the interactive chat loads', () => {
  const history = turns(174);

  render(<KeptChat messages={history} disclaimer="" />);

  expect(screen.queryByText('Question 0')).not.toBeInTheDocument();
  expect(screen.queryByText('Answer 133')).not.toBeInTheDocument();
  expect(screen.getByText('Question 134')).toBeInTheDocument();
  expect(screen.getByText('Answer 173')).toBeInTheDocument();
  expect(history).toHaveLength(174);
  expect(history[0]?.content).toBe('Question 0');
});

const tenTurns = turns(20);
const rowsTall = (rowHeight: number, scrollerHeight: () => number) => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => document.querySelectorAll('.copilotKitMessage').length * rowHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(scrollerHeight);
};

it('formats only the latest Turns that overflow its scroller, adding Turns before the first paint until they do', () => {
  rowsTall(100, () => 250);

  render(<KeptChat messages={tenTurns} disclaimer="" />);

  expect(screen.queryByText('Answer 15')).not.toBeInTheDocument();
  expect(screen.getByText('Question 16')).toBeInTheDocument();
  expect(screen.getByText('Question 18')).toBeInTheDocument();
});

it('adds Turns as its scroller grows past them', () => {
  let height = 250;
  rowsTall(100, () => height);
  const view = render(<KeptChat messages={tenTurns} disclaimer="" />);
  const scroller = view.container.querySelector('[style*="overflow: auto"]');
  if (scroller === null) throw new Error('no scroller');

  height = 500;
  resize(scroller);

  expect(screen.queryByText('Answer 13')).not.toBeInTheDocument();
  expect(screen.getByText('Question 14')).toBeInTheDocument();
});

it('shows, from the commit that mounts it, the Turns the copy it replaces showed', () => {
  rowsTall(100, () => 250);
  const latestShown = { current: 1 };
  const fallback = render(<KeptChat messages={tenTurns} disclaimer="" latestShown={latestShown} />);
  fallback.unmount();
  let mounted: string[] = [];
  const read = () => {
    mounted = [...document.querySelectorAll('.copilotKitUserMessage')].map((row) => row.textContent);
  };

  render(<><KeptChat messages={tenTurns} disclaimer="" latestShown={latestShown} /><AfterKeptChat read={read} /></>);

  expect(mounted).toEqual(['Question 16', 'Question 18']);
});

it('keeps a recent answer and its Worklog when the render window starts inside its Turn', async () => {
  const history: Message[] = [
    { id: 'question', role: 'user', content: 'Read the close.' },
    ...Array.from({ length: 45 }, (_, index): Message => ({ id: `thought-${index}`, role: 'reasoning', content: `Thought ${index}` })),
    { id: 'call', role: 'assistant', content: 'Reading the close.', toolCalls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { id: 'result', role: 'tool', toolCallId: 'read', content: '{"close":4.12}' },
    { id: 'answer', role: 'assistant', content: 'The 10y closed at **4.12%**.' },
  ];
  const view = render(<KeptChat messages={history} disclaimer="" />);

  expect(screen.queryByText('Read the close.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Worked' })).toHaveAttribute('aria-expanded', 'false');
  await waitFor(() => expect(view.container.querySelector('.copilotKitAssistantMessage [data-streamdown="strong"]')).toHaveTextContent('4.12%'));
  expect(view.container).not.toHaveTextContent('Reading the close.');
  expect(view.container).not.toHaveTextContent('{"close":4.12}');
});

it("shows a kept question's files as cards above its bubble, which holds only what the user typed", () => {
  const view = render(
    <KeptChat
      messages={[
        { id: 'm1', role: 'user', content: 'check this\n\nAttached files:\n- /AI_Trends_2026.pdf' },
        { id: 'm2', role: 'user', content: '\n\nAttached files:\n- /report.csv' },
      ]}
      disclaimer="Check important info."
    />,
  );
  const [question, filesOnly] = view.container.querySelectorAll('.copilotKitUserMessage');

  expect(question?.querySelector('.sent-files')).toHaveTextContent('AI_Trends_2026.pdfPDF');
  expect(question?.querySelector('[class*="cpk:prose"]')).toHaveTextContent(/^check this$/);
  expect(view.container).not.toHaveTextContent('Attached files:');
  expect(filesOnly?.querySelector('.sent-files')).toHaveTextContent('report.csvCSV');
  expect(filesOnly?.querySelector('[class*="cpk:prose"]')).toBeNull();
});

it('shows the disclaimer and the composer accessory where the composer will be', () => {
  renderKept();

  expect(screen.getByText('Check important info.')).toBeInTheDocument();
  expect(screen.getByText('Signed out').closest('.composer-accessory')).not.toBeNull();
});

// The composer shows at rest from the chat's first paint, as the chat surface's will once its picker is placed.
it('shows the composer at rest, with nothing in it to use', () => {
  renderKept();

  const composer = document.querySelector<HTMLElement>('.copilotKitInput');
  if (composer === null) throw new Error('no composer');
  expect(composer).toHaveAttribute('inert');
  expect(composer).toHaveAttribute('aria-hidden', 'true');
  // globals.css hides a composer until its model picker is placed; this one has none.
  expect(composer.style.visibility).toBe('visible');
  expect(within(composer).getByPlaceholderText('Ask anything')).toHaveAttribute('readonly');
  expect(within(composer).getByRole('button', { name: 'Send', hidden: true })).toBeDisabled();
  expect(within(composer).getByRole('button', { name: 'Add photos & files', hidden: true })).toBeInTheDocument();
});

it("ends the messages the composer's height plus 32px above the bottom, as the composer resizes", () => {
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
  const { content } = renderKept();
  expect(content.style.paddingBottom).toBe('152px');

  height.mockReturnValue(160);
  const composer = [...observed.keys()].find((element) => element.classList.contains('cpk:z-20'));
  if (composer === undefined) throw new Error('the composer is not observed');
  resize(composer);

  expect(content.style.paddingBottom).toBe('192px');
});

// The kept Main Chat that replaces the Suspense fallback's as the chat surface mounts: a browser re-rendered it with its
// composer's room only after the chat had opened, which a phone's page had scrolled by that room.
it("ends the messages the composer's height plus 32px above the bottom from the commit that mounts it", () => {
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
  let mounted: string | undefined;
  const read = () => {
    mounted = document.querySelector('.copilotKitMessages')?.closest<HTMLElement>('[style*="padding-bottom"]')?.style.paddingBottom;
  };
  render(<><KeptChat messages={messages} disclaimer="Check important info." /><AfterKeptChat read={read} /></>);
  height.mockRestore();

  expect(mounted).toBe('152px');
});

// On a desktop, 1px short of its end, where the chat surface's scroll view keeps its latest message, so that message
// does not move as the chat surface takes over.
it('opens at the latest message, and stays there as the messages grow', () => {
  let scrollHeight = 900;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  const { scroller } = renderKept();
  expect(scroller.scrollTop).toBe(599);

  scrollHeight = 1400;
  const scrolled = scroller.firstElementChild;
  if (scrolled === null) throw new Error('no scroll content');
  resize(scrolled);

  expect(scroller.scrollTop).toBe(1099);
});

// A phone's page is held by use-stick-to-bottom too, 1px short of its end, so the kept chat opens there.
it('opens 1px short of the end of its messages on a phone, as the chat surface does', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: query === '(max-width: 640px)', media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  const { scroller } = renderKept();
  expect(scroller.scrollTop).toBe(599);
});

// The chat surface's own layout, which the cold-open check measures in a browser.
it("lays out its scroll view and composer room as CopilotKit 1.77's chat view does", () => {
  const { view, scroller } = renderKept();
  const scrolled = scroller.firstElementChild;
  if (!(scrolled instanceof HTMLElement)) throw new Error('no scroll content');
  const banner = view.container.querySelector('[style*="padding-bottom: var"]');
  if (!(banner instanceof HTMLElement)) throw new Error('no banner offset');

  expect([scroller.style.height, scroller.style.width, scroller.style.overflow]).toEqual(['100%', '100%', 'auto']);
  expect([scrolled.style.flex, scrolled.style.minHeight]).toEqual(['1 1 0%', '0']);
  expect(banner.style.paddingBottom).toBe('var(--copilotkit-license-banner-offset, 0px)');
});

it('stops observing as it unmounts', () => {
  const { view } = renderKept();
  // The composer, the scroll view, its content, and the message list whose bubbles fit their lines.
  expect(observed.size).toBe(4);

  view.unmount();

  expect(observed.size).toBe(0);
});

it.each([
  "\\[2\\",
  "\\[\n2\n\\",
  "Using the sum-of-squares formula:\n\n\\[\n\\sum_{n=1}^{20} n^2\n= \\",
])('does not expose a generated repair URI when opening a saved reply: %j', (content) => {
  const saved: Message[] = [{ id: 'saved', role: 'assistant', content }];
  const view = render(<KeptChat messages={saved} disclaimer="" />);
  expect(view.container).not.toHaveTextContent('streamdown:incomplete-link');
  expect(view.container).toHaveTextContent(content.includes('formula') ? 'sum-of-squares formula' : '2');
  view.unmount();
  const reload = render(<KeptChat messages={saved} disclaimer="" />);
  expect(reload.container).not.toHaveTextContent('streamdown:incomplete-link');
});

it.each([
  { content: '[pending', visible: 'pending' },
  { content: '[pending\\', visible: '[pending\\' },
  { content: '\\[2\\]', visible: '[2]' },
  { content: 'Before \\[2\\] then [pending\\', visible: 'Before [2] then [pending\\' },
  { content: '`\\[2\\](streamdown:incomplete-link)`', visible: '\\[2\\](streamdown:incomplete-link)' },
  { content: String.raw`\\[literal\\]`, visible: String.raw`\[literal\]` },
  { content: '\\[2\\](&#115;treamdown:incomplete-link)', visible: '[2](streamdown:incomplete-link)' },
])('preserves saved reply text without eager math plugins: $content', ({ content, visible }) => {
  const view = render(<KeptChat messages={[{ id: 'saved', role: 'assistant', content }]} disclaimer="" />);
  expect(view.container.textContent).toBe(visible);
  expect(view.container.querySelector('.katex')).toBeNull();
});

it('keeps a completed saved math reply visible on cold open without changing the raw question', () => {
  const question = 'Explain \\[2\\](streamdown:incomplete-link)';
  const content = "Using the sum-of-squares formula:\n\n\\[\n\\sum_{n=1}^{20} n^2\n= \\frac{20(20+1)(2\\cdot20+1)}{6}\n= \\frac{20\\cdot21\\cdot41}{6}\n= 70\\cdot41\n= \\boxed{2870}.\n\\]";
  const saved: Message[] = [
    { id: 'question', role: 'user', content: question },
    { id: 'reply', role: 'assistant', content },
  ];
  const view = render(<KeptChat messages={saved} disclaimer="" />);
  expect(view.container.querySelector('.copilotKitUserMessage')).toHaveTextContent(question);
  expect(view.container.querySelector('.copilotKitAssistantMessage')).toHaveTextContent('2870');
  expect(view.container.querySelector('.copilotKitAssistantMessage')).not.toHaveTextContent('streamdown:incomplete-link');
  expect(view.container.querySelector('.katex')).toBeNull();
});

it("folds a Turn's work into its Worklog, as the chat surface will, so its answer keeps its place", () => {
  const started = Date.parse('2026-10-11T14:05:41Z');
  const turn: Message[] = [
    { id: 'w1', role: 'user', content: 'Where did rates close?' },
    { id: 'w2', role: 'reasoning', content: '**Planning**' },
    {
      id: 'w3',
      role: 'assistant',
      content: "I'll read the close.",
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { started_at: started, ended_at: started + 1000 },
    },
    { id: 'w4', role: 'tool', toolCallId: 'call-1', content: '{"close":4.12}' },
    { id: 'w5', role: 'assistant', content: 'The 10y closed at 4.12%.', metadata: { started_at: started + 2000, ended_at: started + 9000 } },
  ];
  const view = render(<KeptChat messages={turn} disclaimer="Check important info." />);
  const list = view.container.querySelector('.copilotKitMessages');

  expect([...(list?.children ?? [])].map((row) => row.className.split(' ').find((name) => name !== 'copilotKitMessage'))).toEqual([
    'copilotKitUserMessage',
    'worklog',
    'copilotKitAssistantMessage',
  ]);
  expect(screen.getByRole('button', { name: 'Worked for 9s' })).toHaveAttribute('aria-expanded', 'false');
  expect(list).not.toHaveTextContent("I'll read the close.");
});

it("shows a reply's links as the chat surface will: a citation as its pill, a link as a link", () => {
  const view = render(
    <KeptChat
      messages={[
        { id: 'q', role: 'user', content: 'Where did rates close?' },
        { id: 'r', role: 'assistant', content: 'Steeper.[[1]](https://example.com/a) See [the note](https://example.com/b).' },
      ]}
      disclaimer=""
    />,
  );
  const [citation, link] = view.container.querySelectorAll('.copilotKitAssistantMessage a');

  expect(citation).toHaveAttribute('data-citation');
  expect(citation).toHaveTextContent(/^\[1\]$/);
  expect(link).toHaveAttribute('href', 'https://example.com/b');
  expect(view.container.querySelector('button[data-streamdown="link"]')).toBeNull();
});

it('shows a file a reply links to on a line of its own as its card, as the chat surface will', () => {
  // Its URL never comes: the card shows without it.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const view = render(
    <KeptChat
      messages={[
        { id: 'q', role: 'user', content: 'Send me the deck' },
        { id: 'r', role: 'assistant', content: 'Here it is.\n\n[Download q3-board-deck.pptx](/artifacts/q3-board-deck.pptx)' },
      ]}
      disclaimer=""
    />,
  );
  const card = view.container.querySelector('.copilotKitAssistantMessage .reply-file');

  expect(card).toHaveTextContent('q3-board-deck.pptxPPTX');
  expect(card?.closest('p')).toBeNull();
});

it('keeps a scheduled run as its card with Open before the live chat takes over', () => {
  const open = vi.fn();
  const run = { title: 'Morning brief', ranAt: '2026-10-09T12:00:00.000Z', text: 'Rates fell.', status: 'done', sideChat: 'task-1', messageId: 'm-1' } as const;
  render(<KeptChat messages={[{ id: 'scheduled', role: 'assistant', content: 'Scheduled task plain-text fallback', metadata: { scheduledRun: run } }]} disclaimer="" onOpenRun={open} />);

  expect(screen.getByText('Morning brief')).toBeInTheDocument();
  expect(screen.getByText('Done')).toBeInTheDocument();
  expect(screen.queryByText('Scheduled task plain-text fallback')).toBeNull();
  screen.getByRole('button', { name: 'Open' }).click();
  expect(open).toHaveBeenCalledWith(run);
});

it('keeps an unreached scheduled run without an Open action', () => {
  render(<KeptChat messages={[{ id: 'skipped', role: 'assistant', content: 'Scheduled task fallback', metadata: { scheduledRun: { title: 'Paused brief', ranAt: '2026-10-09T12:00:00.000Z', text: 'The task was paused.', status: 'skipped' } } }]} disclaimer="" onOpenRun={vi.fn()} />);

  expect(screen.getByText('Skipped')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
});
