// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Sheet } from 'botcube-artifact-check/sheet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { excelOf } from './sheet-excel';
import { readImports } from './sheet-import';
import type { ImportedSheets } from './sheet-model';

// The agent's computed table as the agent writes it, with openpyxl (the harness's Python tools pin 3.1.5): formulas
// with no stored results, a `0.0%` format, a bold header and the header row frozen.
const ORDERS_PY = `
import sys
from openpyxl import Workbook
from openpyxl.styles import Font

book = Workbook()
sheet = book.active
sheet.title = 'Orders'
sheet.append(['Region', 'Orders', 'Returns', 'Kept', 'Return rate'])
for row, (region, orders, returns) in enumerate([('North', 120, 12), ('South', 95, 7), ('East', 80, 4), ('West', 65, 9)], start=2):
    sheet.append([region, orders, returns, f'=B{row}-C{row}', f'=C{row}/B{row}'])
    sheet.cell(row, 5).number_format = '0.0%'
for cell in sheet[1]:
    cell.font = Font(bold=True)
sheet.freeze_panes = 'A2'
book.save(sys.argv[1])
`;
const COPY = '/artifacts/sheets/q4.sheet.json.versions/imports/0a1b.xlsx';
const SHEET: Sheet = { edits: [
  { kind: 'importFile', asset: '/data/orders.xlsx' },
  { kind: 'writeCells', sheet: 'Orders', topLeft: 'A6', rows: [['Total', '=SUM(B2:B5)', '=SUM(C2:C5)', '=SUM(D2:D5)', '=C6/B6']] },
] };
const soffice = spawnSync('soffice', ['--version'], { encoding: 'utf8' }).status === 0;

let folder: string;
let imported: ImportedSheets;
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'sheet-import-openpyxl-'));
  const workbook = path.join(folder, 'orders.xlsx');
  execFileSync('uv', ['run', '--no-project', '--with', 'openpyxl==3.1.5', 'python', '-c', ORDERS_PY, workbook], { stdio: 'ignore' });
  const bytes = new Uint8Array(await readFile(workbook)).buffer;
  imported = await readImports(SHEET, [{ edit: 0, from: '/data/orders.xlsx', path: COPY }], async () => bytes);
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('an openpyxl workbook imported into a Sheet', () => {
  it('comes in with its formulas, percent format, bold header and frozen row', () => {
    const [orders] = imported.get(0) ?? [];

    expect(orders?.name).toBe('Orders');
    expect(orders?.cells.get('1,3')).toMatchObject({ value: null, formula: 'B2-C2' });
    expect(orders?.cells.get('1,4')).toMatchObject({ value: null, formula: 'C2/B2', style: { pattern: '0.0%' } });
    expect(orders?.cells.get('0,0')).toMatchObject({ value: 'Region', style: { bold: true } });
    expect(orders?.frozenRows).toBe(1);
  });

  // Spawns LibreOffice, so it runs where `soffice` is installed and is skipped elsewhere, as CI's runners have none.
  it.skipIf(!soffice)('computes its formulas once downloaded as Excel and opened in LibreOffice', async () => {
    await writeFile(path.join(folder, 'q4.xlsx'), new Uint8Array(await (await excelOf(SHEET, imported)).arrayBuffer()));
    execFileSync('soffice', [
      `-env:UserInstallation=file://${folder}/profile`, '--headless', '--convert-to', 'csv', '--outdir', folder, path.join(folder, 'q4.xlsx'),
    ], { stdio: 'ignore' });
    const rows = (await readFile(path.join(folder, 'q4.csv'), 'utf8')).trim().split(/\r?\n/).map((row) => row.split(','));

    expect(rows[1]).toEqual(['North', '120', '12', '108', '10%']);
    expect(rows[2]?.slice(0, 4)).toEqual(['South', '95', '7', '88']);
    expect(rows[5]?.slice(0, 4)).toEqual(['Total', '360', '32', '328']);
  });
});
