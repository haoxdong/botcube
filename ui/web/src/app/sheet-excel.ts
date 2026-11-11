import type { Sheet } from "botcube-artifact-check/sheet";
import type { Cell as ExcelCell, Worksheet } from "exceljs";

import { dateOf, keyOf, replay, type Cell, type ImportedSheets, type Line, type SheetModel } from "./sheet-model";

export const EXCEL_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** `value` without its undefined keys: ExcelJS reads a key that is there, even undefined, as set. */
const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

/** Excel's column width unit is about seven pixels of its default font. */
const PIXELS_PER_WIDTH = 7;

const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;
const side = (line: Line | undefined) => line ? { style: line.style, color: { argb: argb(line.color) } } : undefined;

/** One cell into the Excel cell at its place: a formula stays a formula, a date cell is a date. */
function writeCell(target: ExcelCell, { value, formula, style }: Cell) {
  const date = typeof value === "number" && /y/.test(style.pattern ?? "");
  target.value = formula !== undefined ? { formula } : date ? dateOf(value) : value;
  target.font = defined({
    name: "Arial", size: style.size ?? 10, bold: style.bold, italic: style.italic, underline: style.underline, strike: style.strike,
    color: style.color === undefined ? undefined : { argb: argb(style.color) },
  });
  if (style.fill !== undefined) target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(style.fill) } };
  const alignment = defined({ horizontal: style.horizontal, vertical: style.vertical === "center" ? ("middle" as const) : style.vertical, wrapText: style.wrap || undefined });
  if (Object.keys(alignment).length > 0) target.alignment = alignment;
  if (style.pattern !== undefined) target.numFmt = style.pattern;
  const border = defined({ top: side(style.top), right: side(style.right), bottom: side(style.bottom), left: side(style.left) });
  if (Object.keys(border).length > 0) target.border = border;
}

function writeSheet(worksheet: Worksheet, model: SheetModel) {
  for (const [key, cell] of model.cells) {
    const [r, c] = keyOf(key);
    writeCell(worksheet.getCell(r + 1, c + 1), cell);
  }
  for (const [c, width] of model.widths) worksheet.getColumn(c + 1).width = width / PIXELS_PER_WIDTH;
  for (const [r1, c1, r2, c2] of model.merges) worksheet.mergeCells(r1 + 1, c1 + 1, r2 + 1, c2 + 1);
}

/**
 * A Sheet as an Excel file, written with ExcelJS (loaded on Download only) from the same replay the grid shows: formulas
 * stay formulas, and each cell keeps its font, fill, alignment, number format and borders. `imported` holds the sheets
 * read from the store's copies of the Files the Sheet imports.
 */
export async function excelOf(sheet: Sheet, imported?: ImportedSheets): Promise<Blob> {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  for (const model of replay(sheet, imported).sheets) {
    const frozen = model.frozenRows > 0 || model.frozenColumns > 0;
    writeSheet(book.addWorksheet(model.name, {
      views: [{ state: frozen ? "frozen" : "normal", xSplit: model.frozenColumns, ySplit: model.frozenRows, showGridLines: !model.gridlinesHidden }],
    }), model);
  }
  return new Blob([await book.xlsx.writeBuffer()], { type: EXCEL_TYPE });
}
