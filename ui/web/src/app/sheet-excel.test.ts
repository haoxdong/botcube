// @vitest-environment node
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { excelOf } from './sheet-excel';

// claude.ai's own example edits, as the skill page teaches them (renameSheet, makeDropdown, checkboxes and tables left
// out: a Sheet doesn't take them yet).
const BUDGET = { edits: [
  { kind: 'writeCells', sheet: 'Budget', topLeft: 'A1', rows: [['Item', 'Cost'], ['Rent', 1200], ['Zip', "'02139"], ['Total', '=SUM(B2:B3)']] },
  { kind: 'formatCells', sheet: 'Budget', ranges: ['A1:B1', 'A4:B4'], format: {
    font: { bold: true, italic: false, underline: 'none', strikethrough: false, size: 12, color: { kind: 'rgb', hex: '#ffffff' } },
    fillColor: { kind: 'standard', hue: 'blue', shade: 600 },
    alignment: { horizontal: 'center', vertical: 'center', wrap: true },
    numberFormat: { pattern: '$#,##0.00' },
    border: { bottom: { kind: 'line', style: 'medium', color: { kind: 'none' } } },
  } },
  { kind: 'setBorders', sheet: 'Budget', range: 'A1:B4', edges: 'outer', border: { kind: 'line', style: 'thin', color: { kind: 'none' } } },
  { kind: 'setColumnWidths', sheet: 'Budget', columns: 'A:B', widthInPixels: 160 },
  { kind: 'mergeCells', sheet: 'Budget', ranges: ['A6:B6'] },
  { kind: 'setSheetSettings', sheet: 'Budget', settings: { areGridlinesHidden: true } },
  { kind: 'writeCells', sheet: 'Tasks', topLeft: 'A1', rows: [['Task', 'Done', 'Hours', 'Share', 'Due']] },
  { kind: 'writeCells', sheet: 'Tasks', topLeft: 'A2', rows: [['Draft the brief', true, 3, '50%', '2026-03-02'], ['Book the venue', false, 1.5, '25%', '2026-03-09']] },
  { kind: 'writeCells', sheet: 'Tasks', topLeft: 'G1', rows: [['Hours left', '=SUMIFS(C2:C,B2:B,FALSE)']] },
  { kind: 'setSheetSettings', sheet: 'Tasks', settings: { lastFrozenRow: 1 } },
] } as const;

async function opened(sheet: object) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await (await excelOf(sheet as never)).arrayBuffer());
  return book;
}

function worksheet(book: ExcelJS.Workbook, name: string) {
  const found = book.getWorksheet(name);
  if (found === undefined) throw new Error(`The Excel file has no sheet ${name}`);
  return found;
}

describe('a Sheet downloaded as Excel', () => {
  it('keeps its formulas as formulas, and its values as typed', async () => {
    const book = await opened(BUDGET);
    const budget = worksheet(book, 'Budget');
    const tasks = worksheet(book, 'Tasks');

    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Budget', 'Tasks']);
    expect(budget.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)' });
    expect(budget.getCell('B2').value).toBe(1200);
    expect(budget.getCell('B3').value).toBe('02139');
    expect(tasks.getCell('B2').value).toBe(true);
    expect(tasks.getCell('D2').value).toBe(0.5);
    expect(tasks.getCell('D2').numFmt).toBe('0%');
    expect(tasks.getCell('E2').value).toEqual(new Date(Date.UTC(2026, 2, 2)));
  });

  it("keeps claude.ai's open-ended range as written, which Excel and LibreOffice can't compute", async () => {
    // Google Sheets reads `C2:C` as the column from C2 down; Excel has no such range. The formula is carried
    // verbatim, so the gap shows in the file as it does in the grid, until the example is fixed or kept out.
    const tasks = worksheet(await opened(BUDGET), 'Tasks');

    expect(tasks.getCell('H1').value).toEqual({ formula: 'SUMIFS(C2:C,B2:B,FALSE)' });
  });

  it('keeps the formats, borders, widths, merges, frozen rows and gridlines', async () => {
    const book = await opened(BUDGET);
    const budget = worksheet(book, 'Budget');
    const tasks = worksheet(book, 'Tasks');
    const total = budget.getCell('B4');

    expect(total.font).toMatchObject({ bold: true, size: 12, color: { argb: 'FFFFFFFF' } });
    expect(total.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } });
    expect(total.alignment).toMatchObject({ horizontal: 'center', vertical: 'middle', wrapText: true });
    expect(total.numFmt).toBe('$#,##0.00');
    expect(total.border).toMatchObject({ bottom: { style: 'thin' }, right: { style: 'thin' } });
    expect(budget.getCell('A1').border).toMatchObject({ top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'medium' } });
    expect(budget.getColumn(1).width).toBeCloseTo(160 / 7);
    expect(budget.getCell('B6').isMerged).toBe(true);
    expect(budget.views[0]).toMatchObject({ showGridLines: false });
    expect(tasks.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });
});
