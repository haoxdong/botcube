// @vitest-environment node
import type { Imported } from 'botcube-artifact-check/record';
import type { Sheet } from 'botcube-artifact-check/sheet';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { ordersXlsx } from '../../test/orders-workbook';
import { excelOf } from './sheet-excel';
import { readImports } from './sheet-import';
import { replay } from './sheet-model';

const XLSX_COPY = '/artifacts/sheets/q4.sheet.json.versions/imports/0a1b.xlsx';
const CSV_COPY = '/artifacts/sheets/q4.sheet.json.versions/imports/2c3d.csv';
const IMPORTS: Imported[] = [
  { edit: 0, from: '/data/orders.xlsx', path: XLSX_COPY },
  { edit: 1, from: '/data/targets.csv', path: CSV_COPY },
];
const CSV = 'Region,Target,Note\nNorth,150,=B2*2\nSouth,100,on track\n';

async function reader(): Promise<(path: string) => Promise<ArrayBuffer>> {
  const files: Record<string, ArrayBuffer> = { [XLSX_COPY]: await ordersXlsx(), [CSV_COPY]: new TextEncoder().encode(CSV).slice().buffer };
  return async (path) => {
    const file = files[path];
    if (file === undefined) throw new Error(`No file ${path}`);
    return file;
  };
}

const SHEET: Sheet = { edits: [
  { kind: 'importFile', asset: '/data/orders.xlsx' },
  { kind: 'importFile', asset: '/data/targets.csv' },
  { kind: 'writeCells', sheet: 'Orders', topLeft: 'A6', rows: [['Total', '=SUM(B2:B5)']] },
  { kind: 'formatCells', sheet: 'Orders', ranges: ['A6:B6'], format: { font: { italic: true } } },
] };

async function exported(sheet: Sheet) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await (await excelOf(sheet, await readImports(sheet, IMPORTS, await reader()))).arrayBuffer());
  return book;
}

describe("a Sheet's imported File", () => {
  it("reads an .xlsx import's formulas, percent format, bold header and frozen row", async () => {
    const [orders] = (await readImports(SHEET, IMPORTS, await reader())).get(0) ?? [];

    expect(orders?.name).toBe('Orders');
    expect(orders?.cells.get('1,3')).toMatchObject({ value: null, formula: 'B2-C2' });
    expect(orders?.cells.get('1,4')).toMatchObject({ formula: 'C2/B2', style: { pattern: '0.0%' } });
    expect(orders?.cells.get('0,4')).toMatchObject({ value: 'Return rate', style: { bold: true } });
    expect(orders?.cells.get('2,1')).toMatchObject({ value: 95 });
    expect(orders?.frozenRows).toBe(1);
  });

  it('keeps the imported formulas, percent format, bold header and frozen row in the Excel Export, with the later edits on top', async () => {
    const orders = (await exported(SHEET)).getWorksheet('Orders');

    expect(orders?.getCell('D2').value).toEqual({ formula: 'B2-C2' });
    expect(orders?.getCell('E5').value).toEqual({ formula: 'C5/B5' });
    expect(orders?.getCell('E2').numFmt).toBe('0.0%');
    expect(orders?.getCell('E1').font).toMatchObject({ bold: true });
    expect(orders?.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(orders?.getCell('B6').value).toEqual({ formula: 'SUM(B2:B5)' });
    expect(orders?.getCell('B6').font).toMatchObject({ italic: true });
  });

  it('reads a .csv as values only, into a sheet named after the File, its formulas as text', async () => {
    const book = await exported(SHEET);
    const targets = book.getWorksheet('targets');

    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Orders', 'targets']);
    expect(targets?.getCell('A2').value).toBe('North');
    expect(targets?.getCell('B2').value).toBe(150);
    expect(targets?.getCell('C2').value).toBe('=B2*2');
  });

  it('always makes new sheets: an import whose sheet name is taken comes in beside it', async () => {
    const sheet: Sheet = { edits: [
      { kind: 'writeCells', sheet: 'Orders', topLeft: 'A1', rows: [['Notes']] },
      { kind: 'importFile', asset: '/data/orders.xlsx' },
    ] };
    const imports = await readImports(sheet, [{ edit: 1, from: '/data/orders.xlsx', path: XLSX_COPY }], await reader());

    expect(replay(sheet, imports).sheets.map((model) => model.name)).toEqual(['Orders', 'Orders (2)']);
  });

  it('refuses an import step the version keeps no copy of', async () => {
    await expect(readImports(SHEET, IMPORTS.slice(0, 1), await reader())).rejects.toThrow(
      'Edit 1 imports /data/targets.csv, and this version keeps no copy of it',
    );
  });
});
