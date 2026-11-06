import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import MarkdownRenderer from './markdown-renderer';

// pdf.js, which happy-dom cannot run: a document whose first page renders as `render` resolves.
const pdf = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist', () => pdf);

/** The Files routes' download URL for each file, by its name in Files; any other name is missing. */
function files(urls: Record<string, string>) {
  const fetchImpl = vi.fn(async (input: string) => {
    const name = new URL(input).searchParams.get('name') ?? '';
    const url = urls[name];
    return url === undefined
      ? Response.json({ detail: `No file named ${name}` }, { status: 404 })
      : Response.json({ url });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

/** A loading task for a one-page PDF, its page drawn as `render` settles. */
function pdfTask(render: () => Promise<void>) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: render() })),
  };
  const task = {
    promise: Promise.resolve({ getPage: async () => page }),
    destroy: vi.fn(async () => {}),
  };
  pdf.getDocument.mockReturnValue(task);
  return { page, task };
}

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(() => {
  assign = vi.fn();
  vi.spyOn(window.location, 'assign').mockImplementation(assign);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  pdf.getDocument.mockReset();
});

it('shows a lone link to a file in Files as its card, in place of the paragraph, and downloads it from a fresh URL', async () => {
  const fetchImpl = files({ 'artifacts/q3-board-deck.pptx': 'https://files.test/q3-board-deck.pptx' });
  const view = render(
    <MarkdownRenderer content={'Here is the deck.\n\n[Download q3-board-deck.pptx](/artifacts/q3-board-deck.pptx)'} />
  );
  // Its name, kind and icon show before its URL comes.
  const card = view.container.querySelector('.reply-file');
  expect(card).toHaveTextContent('q3-board-deck.pptxPPTX');
  expect(card?.querySelector('svg text')).toHaveTextContent('pptx');
  expect(card?.closest('p')).toBeNull();
  expect(view.container.querySelectorAll('p')).toHaveLength(1);

  const link = await view.findByRole('link', { name: 'Download q3-board-deck.pptx' });
  expect(link).toBe(card);
  expect(link).toHaveAttribute('href', 'https://files.test/q3-board-deck.pptx');
  await userEvent.click(link);
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.test/q3-board-deck.pptx'));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('leaves a link to a file within a sentence a link', async () => {
  files({ 'q3-board-deck.pptx': 'https://files.test/q3-board-deck.pptx' });
  const view = render(<MarkdownRenderer content={'The [board deck](/q3-board-deck.pptx) is ready.'} />);
  const link = await view.findByRole('link', { name: 'board deck' });
  expect(link.closest('p')).toHaveTextContent('The board deck is ready.');
  expect(view.container.querySelector('.reply-file')).toBeNull();
});

/** The card's width as laid out, which happy-dom, laying nothing out, gives as 0. */
const cardWidth = (width: number) => vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(width);

const LISTED_FILES = [
  '[Download one-page CPI summary PDF](/US_CPI_summary.pdf)',
  '[Download 12-month CPI Excel workbook](/US_CPI_12_months.xlsx)',
  '[Download matching PNG chart](/US_CPI_12_months.png)',
];
const INTRO =
  'Created all three files, with source discrepancies and the missing October 2025 observation explicitly flagged.';

it.each([
  ['a bulleted list', LISTED_FILES.map((link) => `- ${link}`).join('\n')],
  ['consecutive lines', LISTED_FILES.join('\n')],
])('shows files linked one per line in %s as their cards, in order, with no list around them', async (_, links) => {
  files({
    'US_CPI_summary.pdf': 'https://files.test/US_CPI_summary.pdf',
    'US_CPI_12_months.xlsx': 'https://files.test/US_CPI_12_months.xlsx',
    'US_CPI_12_months.png': 'https://files.test/US_CPI_12_months.png',
  });
  cardWidth(280);
  pdfTask(async () => {});
  const view = render(<MarkdownRenderer content={`${INTRO}\n\n${links}`} />);
  const cards = [...view.container.querySelectorAll('.reply-file')];
  expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
    'Download one-page CPI summary PDF',
    'Download 12-month CPI Excel workbook',
  ]);
  const image = await view.findByRole('img', { name: 'Download matching PNG chart' });
  expect(image).toHaveAttribute('src', 'https://files.test/US_CPI_12_months.png');
  expect(view.container.querySelector('ul, li, br')).toBeNull();
  expect(cards.concat(image).map((node) => node.closest('p'))).toEqual([null, null, null]);
  expect([...view.container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([INTRO]);
});

it('leaves a list that mixes a file with other text a list of links', async () => {
  files({ 'US_CPI_summary.pdf': 'https://files.test/US_CPI_summary.pdf' });
  const view = render(
    <MarkdownRenderer content={`- ${LISTED_FILES[0]}\n- Source discrepancies flagged`} />
  );
  const link = await view.findByRole('link', { name: 'Download one-page CPI summary PDF' });
  expect(link.closest('li')).not.toBeNull();
  expect(view.container.querySelectorAll('ul > li')).toHaveLength(2);
  expect(view.container.querySelector('.reply-file')).toBeNull();
});

it('leaves a file linked on a line above words a link', async () => {
  files({ 'US_CPI_summary.pdf': 'https://files.test/US_CPI_summary.pdf' });
  const view = render(<MarkdownRenderer content={`${LISTED_FILES[0]}\nThe one-page summary.`} />);
  const link = await view.findByRole('link', { name: 'Download one-page CPI summary PDF' });
  expect(link.closest('p')).toHaveTextContent('Download one-page CPI summary PDF The one-page summary.');
  expect(view.container.querySelector('.reply-file')).toBeNull();
});

it('shows a lone link to an image as the image, named by the link', async () => {
  files({ 'curve.svg': 'https://files.test/curve.svg' });
  const view = render(<MarkdownRenderer content={'[Download curve.svg](/curve.svg)'} />);
  const image = await view.findByRole('img', { name: 'Download curve.svg' });
  expect(image).toHaveAttribute('src', 'https://files.test/curve.svg');
  expect(view.container.querySelector('.reply-file')).toBeNull();
});

it('keeps the card and says why when the file has no download URL', async () => {
  files({});
  const view = render(<MarkdownRenderer content={'[Download q3-board-deck.pptx](/q3-board-deck.pptx)'} />);
  expect(await view.findByRole('alert')).toHaveTextContent(
    'q3-board-deck.pptx could not download: No file named q3-board-deck.pptx'
  );
  expect(view.container.querySelector('.reply-file')).toHaveTextContent('q3-board-deck.pptxPPTX');
});

it("draws a PDF's first page above its name from one plain GET, and lets pdf.js go when the card goes", async () => {
  files({ 'auction-tails.pdf': 'https://files.test/auction-tails.pdf' });
  cardWidth(280);
  const { page, task } = pdfTask(async () => {});
  const view = render(<MarkdownRenderer content={'[Download auction-tails.pdf](/auction-tails.pdf)'} />);
  const canvas = view.container.querySelector('.reply-file[data-preview] .reply-file-preview canvas');
  await waitFor(() => expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ canvas })));
  expect(pdf.getDocument).toHaveBeenCalledWith({
    url: 'https://files.test/auction-tails.pdf',
    disableRange: true,
    disableStream: true,
  });
  expect(pdf.GlobalWorkerOptions.workerSrc).toMatch(/pdf\.worker\.min\.mjs$/);
  expect(view.queryByRole('alert')).toBeNull();
  view.unmount();
  expect(task.destroy).toHaveBeenCalled();
});

it('says in the page box why pdf.js cannot draw the page, the card still downloading', async () => {
  files({ 'auction-tails.pdf': 'https://files.test/auction-tails.pdf' });
  cardWidth(280);
  pdfTask(() => Promise.reject(new Error('Invalid PDF structure.')));
  const view = render(<MarkdownRenderer content={'[Download auction-tails.pdf](/auction-tails.pdf)'} />);
  expect(await view.findByRole('alert')).toHaveTextContent('auction-tails.pdf preview could not load: Invalid PDF structure.');
  expect(view.container.querySelector('.reply-file-preview')).toHaveTextContent('Invalid PDF structure.');
  expect(view.container.querySelector('.reply-file-preview canvas')).toBeNull();
  await userEvent.click(view.getByRole('link', { name: 'Download auction-tails.pdf' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.test/auction-tails.pdf'));
});

it('says why the preview is missing when the card has no width to draw the page across', async () => {
  files({ 'auction-tails.pdf': 'https://files.test/auction-tails.pdf' });
  cardWidth(0);
  const { page } = pdfTask(async () => {});
  const view = render(<MarkdownRenderer content={'[Download auction-tails.pdf](/auction-tails.pdf)'} />);
  expect(await view.findByRole('alert')).toHaveTextContent('auction-tails.pdf preview could not load: the card has no width');
  expect(page.render).not.toHaveBeenCalled();
  expect(view.container.querySelector('.reply-file-preview')).toHaveTextContent('the card has no width');
});

// The agent linked a PDF it never saved to Files; taking the page's box away collapsed the card under the
// user's reading.
it("keeps a missing PDF's page box and says in it why the file cannot download, once", async () => {
  files({});
  const view = render(<MarkdownRenderer content={'[Download us_rates_curve_mindmap.pdf](/mnt/data/us_rates_curve_mindmap.pdf)'} />);
  const box = view.container.querySelector('.reply-file[data-preview] .reply-file-preview');
  expect(box?.querySelector('canvas')).not.toBeNull();
  expect(await view.findByRole('alert')).toHaveTextContent(
    'us_rates_curve_mindmap.pdf could not download: No file named mnt/data/us_rates_curve_mindmap.pdf'
  );
  expect(view.container.querySelector('.reply-file[data-preview] .reply-file-preview')).toBe(box);
  expect(view.getAllByRole('alert')).toHaveLength(1);
  expect(pdf.getDocument).not.toHaveBeenCalled();
});

it("clears a card's download failure once a later click downloads it", async () => {
  const urls: Record<string, string> = { 'q3-board-deck.pptx': 'https://files.test/q3-board-deck.pptx' };
  files(urls);
  const view = render(<MarkdownRenderer content={'[Download q3-board-deck.pptx](/q3-board-deck.pptx)'} />);
  const link = await view.findByRole('link', { name: 'Download q3-board-deck.pptx' });
  await waitFor(() => expect(link).toHaveAttribute('href', 'https://files.test/q3-board-deck.pptx'));

  delete urls['q3-board-deck.pptx'];
  await userEvent.click(link);
  expect(await view.findByRole('alert')).toHaveTextContent('q3-board-deck.pptx could not download: No file named q3-board-deck.pptx');

  urls['q3-board-deck.pptx'] = 'https://files.test/q3-board-deck.pptx';
  await userEvent.click(link);
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.test/q3-board-deck.pptx'));
  expect(view.queryByRole('alert')).toBeNull();
});

// plotly.js, which happy-dom cannot draw: scatter and bar registered, drawing as `react` settles.
const plotly = vi.hoisted(() => ({
  react: vi.fn(async () => undefined),
  purge: vi.fn(),
  PlotSchema: { get: () => ({ traces: { scatter: {}, bar: {} } }) },
}));
vi.mock('../components/plotly-bundle', () => ({ default: async () => plotly }));

/** The Files routes' URL for `name`, and that URL serving `body`. */
function figureFile(name: string, body: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === `https://files.test/${name}`) return new Response(body);
    return new URL(input).searchParams.get('name') === name
      ? Response.json({ url: `https://files.test/${name}` })
      : Response.json({ detail: 'missing' }, { status: 404 });
  }));
}

it.each([
  ['an embedded figure', '![US CPI chart](/cpi.plotly.json)'],
  ['a lone link to a figure', '[US CPI chart](/cpi.plotly.json)'],
])('draws %s as a live Plotly chart from the file, in the app’s look', async (_, content) => {
  figureFile('cpi.plotly.json', '{"data":[{"type":"scatter","y":[3.1,2.9]}],"layout":{"template":{"layout":{}},"title":{"text":"US CPI"}},"config":{"editable":true}}');
  plotly.react.mockClear();
  // tokens.css's colours, which the chart reads as they resolve.
  for (const name of ['text', 'text-muted', 'line', 'white', 'blue', 'green', 'red']) document.documentElement.style.setProperty(`--color-${name}`, '#123456');
  const view = render(<MarkdownRenderer content={`Inflation eased.\n\n${content}`} />);
  const chart = await view.findByRole('figure', { name: 'US CPI chart' });
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  const [element, data, layout, config] = plotly.react.mock.calls[0] as unknown as [HTMLElement, unknown, Record<string, unknown>, Record<string, unknown>];
  expect(element).toBe(chart.querySelector('.plotly-chart'));
  expect(data).toEqual([{ type: 'scatter', y: [3.1, 2.9] }]);
  expect(layout).not.toHaveProperty('template');
  expect(layout).toMatchObject({ title: { text: 'US CPI' }, paper_bgcolor: 'transparent' });
  expect(config).toEqual({ responsive: true, displayModeBar: false, displaylogo: false, showLink: false, showSendToCloud: false, scrollZoom: false });
  expect(view.container.querySelector('img')).toBeNull();
});

it('shows a figure that cannot draw as its reason over its text as code', async () => {
  const text = '{"data":[{"type":"sankee","node":{}}]}';
  figureFile('ohlc.plotly.json', text);
  const view = render(<MarkdownRenderer content={'![Daily bars](/ohlc.plotly.json)'} />);
  expect(await view.findByRole('alert')).toHaveTextContent('Daily bars could not draw: plotly.js has no "sankee" chart type');
  expect(view.container.querySelector('.plotly-chart-failed code')).toHaveTextContent(text);
});
