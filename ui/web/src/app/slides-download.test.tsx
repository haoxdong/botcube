// The export lays slides out in a frame and sanitizes them with DOMPurify, which needs a DOM that walks a tree as
// browsers do.
// @vitest-environment jsdom
import { HttpAgent } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import JSZip from 'jszip';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { ArtifactLayout } from './artifact-panel';
import { FIDELITY_DECK } from '../../test/fixtures/fidelity-deck';
// The panel loads the exporter on Download; loading it with the test keeps transforming PptxGenJS out of the test's time.
import './slides-pptx';

const PUBLISHED = {
  id: '/decks/q3', type: 'slides', title: 'Q3 Operating Review', description: 'Where Q3 landed', version: 1,
  path: '/artifacts/decks/q3.versions/1',
};

/** Files, as the Chat Service's Files routes serve it: a download URL for each stored file, then its text. */
const filesService = setupServer();
beforeAll(() => filesService.listen({ onUnhandledRequest: 'error' }));
afterEach(() => filesService.resetHandlers());
afterAll(() => filesService.close());

/** The published version in Files: the fidelity deck, with `edit` applied to its files. */
function files(edit: (path: string, text: string) => string = (_path, text) => text) {
  const stored = new Map(FIDELITY_DECK.map(({ path, text }) => [path.replace('/decks/q3/', 'artifacts/decks/q3.versions/1/'), edit(path, text)]));
  filesService.use(
    http.get('*/files/download-url', ({ request }) => {
      const name = new URL(request.url).searchParams.get('name') ?? '';
      return stored.has(name) ? HttpResponse.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : HttpResponse.json({ detail: `No file named ${name}` }, { status: 404 });
    }),
    http.get('https://files.test/*', ({ request }) => HttpResponse.text(stored.get(decodeURIComponent(new URL(request.url).pathname.slice(1))) ?? '')),
  );
}

/**
 * The browser's side of a download: object URLs that live until revoked, and a download link's click, whose file the
 * browser reads once the click has returned. jsdom has neither.
 */
function browserDownloads() {
  const saved: { name: string; blob: Blob | undefined }[] = [];
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
    const { href, download: name } = link;
    setTimeout(() => saved.push({ name, blob: urls.get(href) }));
  };
  document.addEventListener('click', download);
  onTestFinished(() => document.removeEventListener('click', download));
  return saved;
}

function openDeck() {
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
  return screen.findByRole('button', { name: /Q3 Operating Review/ }).then((card) => userEvent.click(card));
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_ARTIFACTS', '1');
  // jsdom has no matchMedia: the panel asks whether the screen is a phone's.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
  // jsdom lays nothing out: the resizable panels observe sizes that never change.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('downloads the deck on screen as a PowerPoint of its slides and speaker notes', async () => {
  files();
  const saved = browserDownloads();
  await openDeck();

  await userEvent.click(screen.getByRole('button', { name: 'Download as PowerPoint' }));

  // Writing five slides takes jsdom about a second.
  await waitFor(() => expect(saved).toHaveLength(1), { timeout: 4000 });
  const [file] = saved;
  expect(file?.name).toBe('Q3 Operating Review.pptx');
  const blob = file?.blob;
  if (blob === undefined) throw new Error('The file was gone when the browser read it');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  expect(Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(5);
  expect(await zip.file('ppt/slides/slide4.xml')?.async('string')).toContain('<a:t>New customers</a:t>');
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')?.async('string')).toContain('Open with the headline');
});

it('says what failed when the PowerPoint export fails, and offers the PDF instead', async () => {
  files((path, text) => path.endsWith('/numbers.html') ? text.replace('<h2', '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"><h2') : text);
  const saved = browserDownloads();
  await openDeck();
  const frame = screen.getByTitle<HTMLIFrameElement>('Q3 Operating Review');
  const posted = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: posted }, configurable: true });

  await userEvent.click(screen.getByRole('button', { name: 'Download as PowerPoint' }));

  const failure = await screen.findByRole('alert');
  expect(failure).toHaveTextContent("Couldn't make the PowerPoint: slide numbers: <img> has no PowerPoint form yet.");
  expect(saved).toHaveLength(0);
  await userEvent.click(within(failure).getByRole('button', { name: 'Download as PDF' }));
  expect(posted).toHaveBeenLastCalledWith({ type: 'artifact-print' }, '*');
});
