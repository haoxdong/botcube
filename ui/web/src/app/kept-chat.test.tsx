import type { Message } from '@ag-ui/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

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
  return { view, list, content };
};

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

it('shows the disclaimer and the composer accessory where the composer will be', () => {
  renderKept();

  expect(screen.getByText('Check important info.')).toBeInTheDocument();
  expect(screen.getByText('Signed out').closest('.composer-accessory')).not.toBeNull();
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
// composer's room only after the chat had opened, which a phone's page had scrolled by that room (#3697).
it("ends the messages the composer's height plus 32px above the bottom from the commit that mounts it", () => {
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
  let mounted: string | undefined;
  // Its layout effect runs after the kept chat's, in the same commit, before any update the kept chat makes.
  function AfterKeptChat() {
    useLayoutEffect(() => {
      mounted = document.querySelector('.copilotKitMessages')?.closest<HTMLElement>('[style*="padding-bottom"]')?.style.paddingBottom;
    }, []);
    return null;
  }
  render(<><KeptChat messages={messages} disclaimer="Check important info." /><AfterKeptChat /></>);
  height.mockRestore();

  expect(mounted).toBe('152px');
});

it('opens at the latest message, and stays there as the messages grow', () => {
  let scrollHeight = 900;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
  const { content } = renderKept();
  const scroller = content.closest('[style*="overflow: auto"]');
  if (!(scroller instanceof HTMLElement)) throw new Error('no scroller');
  expect(scroller.scrollTop).toBe(900);

  scrollHeight = 1400;
  const scrolled = scroller.firstElementChild;
  if (scrolled === null) throw new Error('no scroll content');
  resize(scrolled);

  expect(scroller.scrollTop).toBe(1400);
});

// The chat surface's own layout, which the cold-open check measures in a browser.
it("lays out its scroll view and composer room as CopilotKit 1.77's chat view does", () => {
  const { view, content } = renderKept();
  const scroller = content.closest('[style*="overflow: auto"]');
  if (!(scroller instanceof HTMLElement)) throw new Error('no scroller');
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
  expect(observed.size).toBe(2);

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
