import type { Imported } from "botcube-artifact-check/record";
import type { Sheet } from "botcube-artifact-check/sheet";
import type { Cell as ExcelCell, Border, Worksheet } from "exceljs";

import { emptySheet, LINE_COLOUR, type Cell, type ImportedSheets, type Line, type SheetModel } from "./sheet-model";

/**
 * A Sheet's `importFile` steps, read into sheets before the later edits replay. Files keep no versions, so the publish
 * keeps a copy of each imported File in the version store, and the version's record names the copy for each step: that
 * copy is all this reads. An `.xlsx` keeps its formulas, number formats, looks, widths, merges and frozen panes (read
 * with ExcelJS); a `.csv` keeps values only, and a formula in it is text. ExcelJS and the CSV parser load only with an
 * import.
 */

/** Reads each import step's copy (its bytes, through `read`) into sheets. A step the version keeps no copy of fails. */
export async function readImports(sheet: Sheet, imports: readonly Imported[], read: (path: string) => Promise<ArrayBuffer>): Promise<ImportedSheets> {
  const steps = sheet.edits.flatMap((edit, index) => edit.kind === "importFile" ? [{ index, asset: edit.asset }] : []);
  const loaded = await Promise.all(steps.map(async ({ index, asset }) => {
    const kept = imports.find((entry) => entry.edit === index);
    if (kept === undefined) throw new Error(`Edit ${index} imports ${asset}, and this version keeps no copy of it`);
    const bytes = await read(kept.path);
    return [index, /\.csv$/i.test(kept.path) ? await csvSheets(bytes, kept.from) : await xlsxSheets(bytes)] as const;
  }));
  return new Map(loaded);
}

/** A `.csv` as one sheet named after the File: values only, numbers and true/false as such, anything else as text. */
async function csvSheets(bytes: ArrayBuffer, from: string): Promise<SheetModel[]> {
  const { default: Papa } = await import("papaparse");
  // dynamicTyping reads a number, true/false or an empty cell as such; anything else stays text.
  const parsed = Papa.parse<(string | number | boolean | null)[]>(new TextDecoder().decode(bytes), { dynamicTyping: true, skipEmptyLines: true });
  const name = from.slice(from.lastIndexOf("/") + 1).replace(/\.csv$/i, "").replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet1";
  const sheet = emptySheet(name);
  parsed.data.forEach((row, r) => row.forEach((value, c) => {
    if (value === null || value === "") return;
    sheet.cells.set(`${r},${c}`, { value, style: {} });
  }));
  return [sheet];
}

/** An `.xlsx`'s sheets, each cell with its formula or value and its look. */
async function xlsxSheets(bytes: ArrayBuffer): Promise<SheetModel[]> {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book.worksheets.map((worksheet) => sheetOf(worksheet, ExcelJS.ValueType.Formula));
}

function sheetOf(worksheet: Worksheet, formula: number): SheetModel {
  const sheet = emptySheet(worksheet.name);
  worksheet.eachRow({ includeEmpty: false }, (row, r) => row.eachCell({ includeEmpty: false }, (cell, c) => {
    sheet.cells.set(`${r - 1},${c - 1}`, cellOf(cell, cell.type === formula));
  }));
  const view = worksheet.views[0];
  if (view?.state === "frozen") {
    sheet.frozenRows = view.ySplit ?? 0;
    sheet.frozenColumns = view.xSplit ?? 0;
  }
  if (view?.showGridLines === false) sheet.gridlinesHidden = true;
  // A loaded sheet always has its columns (ExcelJS reads them from the file, none when it sets none).
  worksheet.columns.forEach((column, c) => {
    if (column.width !== undefined) sheet.widths.set(c, Math.round(column.width * PIXELS_PER_WIDTH));
  });
  for (const range of worksheet.model.merges) {
    const [first, last = first] = range.split(":");
    if (first === undefined || last === undefined) continue;
    const [from, to] = [worksheet.getCell(first), worksheet.getCell(last)];
    sheet.merges.push([Number(from.row) - 1, Number(from.col) - 1, Number(to.row) - 1, Number(to.col) - 1]);
  }
  return sheet;
}

/** Excel's column width unit is about seven pixels of its default font. */
const PIXELS_PER_WIDTH = 7;
/** Excel's day 0: a date cell is the number of days since. */
const EPOCH = Date.UTC(1899, 11, 30);
const serialOf = (date: Date) => (date.getTime() - EPOCH) / 86_400_000;

function cellOf(cell: ExcelCell, isFormula: boolean): Cell {
  const style = styleOf(cell);
  if (isFormula) return { value: null, formula: cell.formula, style };
  const value = cell.value;
  if (value instanceof Date) return { value: serialOf(value), style: { pattern: "yyyy-mm-dd", ...style } };
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return { value, style };
  // Rich text, a link or an error: the text it shows.
  return { value: cell.text, style };
}

const hexOf = (color: { argb?: string } | undefined) => color?.argb?.length === 8 ? `#${color.argb.slice(2).toLowerCase()}` : undefined;
/** Excel's border styles as the nearest a Sheet takes. */
const LINES: Record<string, NonNullable<Line>["style"]> = {
  thin: "thin", hair: "thin", medium: "medium", thick: "thick", dashed: "dashed", dotted: "dotted", double: "double",
  dashDot: "dashed", dashDotDot: "dashed", slantDashDot: "dashed", mediumDashed: "medium", mediumDashDot: "medium", mediumDashDotDot: "medium",
};
const lineOf = (side: Partial<Border> | undefined): Line | undefined =>
  side?.style === undefined ? undefined : { style: LINES[side.style] ?? "thin", color: hexOf(side.color) ?? LINE_COLOUR };

/** A cell's look as ExcelJS reads it: each part is absent on a cell that sets none, though its types say otherwise. */
type Look = Partial<Pick<ExcelCell, "font" | "fill" | "alignment" | "numFmt" | "border">>;

function styleOf(cell: Look): Cell["style"] {
  const { fill, numFmt, border } = cell;
  const style: Cell["style"] = { ...fontStyle(cell), ...alignmentStyle(cell) };
  const fillColor = fill?.type === "pattern" && fill.pattern === "solid" ? hexOf(fill.fgColor) : undefined;
  if (fillColor !== undefined) style.fill = fillColor;
  if (numFmt && numFmt !== "General") style.pattern = numFmt;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const line = lineOf(border?.[side]);
    if (line !== undefined) style[side] = line;
  }
  return style;
}

function fontStyle({ font }: Look): Cell["style"] {
  const style: Cell["style"] = {};
  if (font?.bold) style.bold = true;
  if (font?.italic) style.italic = true;
  if (font?.underline) style.underline = true;
  if (font?.strike) style.strike = true;
  if (font?.size !== undefined) style.size = font.size;
  const color = hexOf(font?.color);
  if (color !== undefined) style.color = color;
  return style;
}

function alignmentStyle({ alignment }: Look): Cell["style"] {
  const style: Cell["style"] = {};
  const horizontal = alignment?.horizontal;
  if (horizontal === "left" || horizontal === "center" || horizontal === "right") style.horizontal = horizontal;
  const vertical = alignment?.vertical;
  if (vertical === "top" || vertical === "bottom") style.vertical = vertical;
  if (vertical === "middle") style.vertical = "center";
  if (alignment?.wrapText) style.wrap = true;
  return style;
}
