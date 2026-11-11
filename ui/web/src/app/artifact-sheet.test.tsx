import { HttpAgent } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ordersXlsx } from '../../test/orders-workbook';
import { ArtifactLayout } from './artifact-panel';
import type { UniverCells } from './sheet-model';

// Univer draws on a canvas happy-dom doesn't have, so the grid is a stand-in that holds the cells the Viewer gave it
// and lets the test type into them as the User would.
const grid = vi.hoisted(() => ({ cells: null as UniverCells | null, changed: () => {} }));
vi.mock('./sheet-grid', () => ({
  mountGrid: (_container: HTMLElement, data: UniverCells, { rendered, changed }: { rendered: () => void; changed: () => void }) => {
    grid.cells = structuredClone(data);
    grid.changed = changed;
    rendered();
    return { cells: () => grid.cells, dispose: () => {} };
  },
}));

const SHEET = { edits: [{ kind: 'writeCells', sheet: 'Budget', topLeft: 'A1', rows: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300], ['Total', '=SUM(B2:B3)']] }] };
const VERSION_1 = 'artifacts/sheets/budget.sheet.json.versions/1.sheet.json';
const PUBLISHED = { id: '/sheets/budget.sheet.json', type: 'sheet', title: 'Budget', description: 'Monthly costs', version: 1, path: `/${VERSION_1}` };
const ASKED = { id: 'u', role: 'user' as const, content: 'Make the budget sheet' };
const MESSAGES = [
  ASKED,
  { id: 'a', role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: PUBLISHED.id }) } }] },
  { id: 't', role: 'tool' as const, toolCallId: 'c', content: JSON.stringify(PUBLISHED) },
];

function Chat({ messages = MESSAGES }: { messages?: object[] }) {
  return (
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={new HttpAgent({ url: 'https://chat.test/agent' })}>
          <div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div>
        </ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

/** Files holds version 1; `failing` answers its reads from the given one on with a 500. */
function files({ failing = Infinity } = {}) {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === 'https://files.test/1') return (reads += 1) >= failing ? new Response('', { status: 500 }) : new Response(JSON.stringify(SHEET));
    const name = new URL(input).searchParams.get('name');
    return name === VERSION_1 ? Response.json({ url: 'https://files.test/1' }) : Response.json({ detail: `No file named ${name}` }, { status: 404 });
  }));
}

/** The User types `value` into B2 of the grid's `sheet`. */
function typeIntoB2(value: number, sheet = 'Budget') {
  const row = Object.values(grid.cells?.sheets ?? {}).find((shown) => shown.name === sheet)?.cellData?.[1];
  if (row === undefined) throw new Error(`The grid has no row 2 of ${sheet}`);
  row[1] = { v: value };
  act(() => grid.changed());
}

async function openSheet({ title = 'Budget', messages = MESSAGES } = {}) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
  render(<Chat messages={messages} />);
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
  const region = await screen.findByRole('region', { name: title });
  await waitFor(() => expect(region.querySelector('[data-sheet-cells]')).toHaveAttribute('aria-busy', 'false'));
  return within(region);
}

let downloaded: { blob: Blob; name: string }[];
beforeEach(() => {
  downloaded = [];
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((made: Blob | MediaSource) => {
    blob = made as Blob;
    return 'blob:excel';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (blob !== undefined) downloaded.push({ blob, name: this.download });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("downloads the stored version as Excel, with its formulas, and leaves the User's unsaved typing out", async () => {
  files();
  const panel = await openSheet();
  expect(panel.queryByRole('button', { name: 'Download as PDF' })).toBeNull();
  expect(panel.queryByText(/without your unsaved edits/)).toBeNull();

  typeIntoB2(1500);
  expect(await panel.findByText('The Excel file is version 1, without your unsaved edits')).toBeVisible();
  await userEvent.click(panel.getByRole('button', { name: 'Download as Excel' }));

  await waitFor(() => expect(downloaded).toHaveLength(1));
  const [{ blob, name }] = downloaded as [{ blob: Blob; name: string }];
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await blob.arrayBuffer());
  const budget = book.getWorksheet('Budget');
  expect(name).toBe('Budget.xlsx');
  expect(budget?.getCell('B2').value).toBe(1200);
  expect(budget?.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)' });
  expect(panel.queryByRole('alert')).toBeNull();
});

it('names what failed when the Excel Export fails', async () => {
  files({ failing: 2 });
  const panel = await openSheet();

  await userEvent.click(panel.getByRole('button', { name: 'Download as Excel' }));

  expect(await panel.findByRole('alert')).toHaveTextContent("Couldn't make the Excel file: reading version 1 failed: Files answered 500.");
  expect(downloaded).toEqual([]);
});

describe('a Sheet that imports a File', () => {
  const VERSIONS = 'artifacts/sheets/q4.sheet.json.versions';
  const COPY = `${VERSIONS}/imports/0a1b.xlsx`;
  const IMPORT = { kind: 'importFile', asset: '/data/orders.xlsx' };
  const Q4 = { edits: [IMPORT, { kind: 'formatCells', sheet: 'Orders', ranges: ['A1:E1'], format: { font: { italic: true } } }] };
  const Q4_PUBLISHED = { id: '/sheets/q4.sheet.json', type: 'sheet', title: 'Q4 orders', description: '', version: 1, path: `/${VERSIONS}/1.sheet.json` };
  const Q4_MESSAGES = [
    ASKED,
    { id: 'a', role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: Q4_PUBLISHED.id }) } }] },
    { id: 't', role: 'tool' as const, toolCallId: 'c', content: JSON.stringify(Q4_PUBLISHED) },
  ];

  /** Files holding version 1, its record naming the store's copy of the import, and the copy; and the Chat Service's save. */
  async function filesWithImport() {
    const stored: Record<string, string | ArrayBuffer> = {
      [`${VERSIONS}/1.sheet.json`]: JSON.stringify(Q4),
      [`${VERSIONS}/1.json`]: JSON.stringify({ author: 'agent', title: 'Q4 orders', description: '', imports: [{ edit: 0, from: '/data/orders.xlsx', path: `/${COPY}` }] }),
      [COPY]: await ordersXlsx(),
      // The File changed after the publish: the version reads its copy, never this.
      'data/orders.xlsx': 'not the published workbook',
    };
    const saves: { files: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('https://files.test/')) return new Response(stored[decodeURIComponent(input.slice('https://files.test/'.length))]);
      if (new URL(input).pathname === '/files/artifact-save') {
        saves.push(JSON.parse(typeof init?.body === 'string' ? init.body : ''));
        return Response.json({ ...Q4_PUBLISHED, version: 2, author: 'user', path: `/${VERSIONS}/2.sheet.json` });
      }
      const name = new URL(input).searchParams.get('name') ?? '';
      return name in stored ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : Response.json({ detail: `No file named ${name}` }, { status: 404 });
    }));
    return saves;
  }

  it("shows the imported sheet, and saves the User's typing as edits after the import step, without the imported data", async () => {
    const saves = await filesWithImport();
    const panel = await openSheet({ title: 'Q4 orders', messages: Q4_MESSAGES });
    const orders = Object.values(grid.cells?.sheets ?? {}).find((sheet) => sheet.name === 'Orders');
    expect(orders?.cellData?.[1]?.[3]).toMatchObject({ f: '=B2-C2' });
    expect(orders?.cellData?.[0]?.[0]).toMatchObject({ v: 'Region' });

    typeIntoB2(150, 'Orders');
    await userEvent.click(panel.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saves).toHaveLength(1));
    const saved = saves[0]?.files['q4.sheet.json'] ?? '';
    expect(JSON.parse(saved)).toEqual({ edits: [...Q4.edits, { kind: 'writeCells', sheet: 'Orders', topLeft: 'B2', rows: [[150]] }] });
    expect(saved).not.toContain('North');
  });

  it("downloads the stored version as Excel with the imported formulas, percent format, bold header and frozen row", async () => {
    await filesWithImport();
    const panel = await openSheet({ title: 'Q4 orders', messages: Q4_MESSAGES });

    await userEvent.click(panel.getByRole('button', { name: 'Download as Excel' }));

    await waitFor(() => expect(downloaded).toHaveLength(1));
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await (downloaded[0]?.blob ?? new Blob()).arrayBuffer());
    const orders = book.getWorksheet('Orders');
    expect(orders?.getCell('D2').value).toEqual({ formula: 'B2-C2' });
    expect(orders?.getCell('E3').value).toEqual({ formula: 'C3/B3' });
    expect(orders?.getCell('E3').numFmt).toBe('0.0%');
    expect(orders?.getCell('A1').font).toMatchObject({ bold: true, italic: true });
    expect(orders?.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(panel.queryByRole('alert')).toBeNull();
  });
});
