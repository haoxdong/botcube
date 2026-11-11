import type { ICellData, IWorkbookData } from "@univerjs/presets";
import type { CellValue, Color, Edit, Line as SourceLine, Sheet } from "botcube-artifact-check/sheet";

export type Line = { style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double"; color: string } | null;
type Style = {
  bold?: boolean | undefined; italic?: boolean | undefined; underline?: boolean | undefined; strike?: boolean | undefined;
  size?: number | undefined; color?: string | undefined; fill?: string | undefined;
  horizontal?: "left" | "center" | "right" | undefined; vertical?: "top" | "center" | "bottom" | undefined;
  wrap?: boolean | undefined; pattern?: string | undefined;
  top?: Line | undefined; right?: Line | undefined; bottom?: Line | undefined; left?: Line | undefined;
};
/** A cell: its value, or a formula (without its `=`), and its look. */
export type Cell = { value: string | number | boolean | null; formula?: string | undefined; style: Style };
export type SheetModel = {
  name: string;
  /** By `row,column`, both from 0. */
  cells: Map<string, Cell>;
  /** Column widths in pixels, by column from 0. */
  widths: Map<number, number>;
  merges: Array<[number, number, number, number]>;
  frozenRows: number;
  frozenColumns: number;
  gridlinesHidden: boolean;
};
export type Workbook = { sheets: SheetModel[] };
/** The sheets each import step read from its File, by the step's index in the edits. */
export type ImportedSheets = ReadonlyMap<number, readonly SheetModel[]>;

/**
 * claude.ai's standard colors, approximated: its exact palette is its page's own. Tailwind's scale at the same steps.
 */
type Standard = Extract<Color, { kind: "standard" }>;
const HUES: Record<Standard["hue"], Record<Standard["shade"], string>> = {
  gray: { 100: "#f3f4f6", 200: "#e5e7eb", 300: "#d1d5db", 400: "#9ca3af", 600: "#4b5563", 800: "#1f2937" },
  red: { 100: "#fee2e2", 200: "#fecaca", 300: "#fca5a5", 400: "#f87171", 600: "#dc2626", 800: "#991b1b" },
  orange: { 100: "#ffedd5", 200: "#fed7aa", 300: "#fdba74", 400: "#fb923c", 600: "#ea580c", 800: "#9a3412" },
  yellow: { 100: "#fef9c3", 200: "#fef08a", 300: "#fde047", 400: "#facc15", 600: "#ca8a04", 800: "#854d0e" },
  green: { 100: "#dcfce7", 200: "#bbf7d0", 300: "#86efac", 400: "#4ade80", 600: "#16a34a", 800: "#166534" },
  teal: { 100: "#ccfbf1", 200: "#99f6e4", 300: "#5eead4", 400: "#2dd4bf", 600: "#0d9488", 800: "#115e59" },
  blue: { 100: "#dbeafe", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa", 600: "#2563eb", 800: "#1e40af" },
  purple: { 100: "#f3e8ff", 200: "#e9d5ff", 300: "#d8b4fe", 400: "#c084fc", 600: "#9333ea", 800: "#6b21a8" },
  magenta: { 100: "#fae8ff", 200: "#f5d0fe", 300: "#f0abfc", 400: "#e879f9", 600: "#c026d3", 800: "#86198f" },
};
const hexOf = (color: Color): string | undefined =>
  color.kind === "none" ? undefined : color.kind === "rgb" ? color.hex : HUES[color.hue][color.shade];
export const LINE_COLOUR = "#000000";
const lineOf = (line: SourceLine): Line => line.kind === "none" ? null : { style: line.style, color: hexOf(line.color) ?? LINE_COLOUR };

const columnIndex = (letters: string) => [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
const columnLetters = (index: number) => {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
};
const address = (row: number, column: number) => `${columnLetters(column)}${row + 1}`;
const cellOf = (a1: string): [number, number] => {
  const found = /^([A-Z]+)(\d+)$/.exec(a1);
  if (found?.[1] === undefined || found[2] === undefined) throw new Error(`${a1} is not a cell`);
  return [Number(found[2]) - 1, columnIndex(found[1])];
};
const endsOf = (pair: string): [string, string] => {
  const [from = pair, to = from] = pair.split(":");
  return [from, to];
};
const rangeOf = (range: string): [number, number, number, number] => {
  const [from, to] = endsOf(range);
  const [r1, c1] = cellOf(from), [r2, c2] = cellOf(to);
  return [Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)];
};
const columnsOf = (columns: string): [number, number] => {
  const [from, to] = endsOf(columns);
  return [columnIndex(from), columnIndex(to)];
};
export const keyOf = (key: string): [number, number] => {
  const [row, column] = key.split(",").map(Number);
  if (row === undefined || column === undefined) throw new Error(`${key} is not a cell's key`);
  return [row, column];
};

/** Excel's day 0, so a date typed as `2026-03-02` is the serial number Excel and Univer count days by. */
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86_400_000;

/**
 * A value as Google Sheets reads one typed into a cell (the API's `USER_ENTERED`): `=` starts a formula, a leading `'`
 * keeps text, and a percent, money, a number with thousands commas or an ISO date becomes a number with its format.
 */
function typed(value: CellValue): { value: Cell["value"]; formula?: string; pattern?: string } {
  if (typeof value !== "string") return { value };
  if (value.startsWith("=")) return { value: null, formula: value.slice(1) };
  if (value.startsWith("'")) return { value: value.slice(1) };
  if (/^(true|false)$/i.test(value)) return { value: value.toLowerCase() === "true" };
  const percent = /^(-?[\d,]*\.?\d+)%$/.exec(value)?.[1];
  if (percent !== undefined) return { value: Number(percent.replaceAll(",", "")) / 100, pattern: percent.includes(".") ? "0.0%" : "0%" };
  const money = /^\$(-?[\d,]*\.?\d+)$/.exec(value)?.[1];
  if (money !== undefined) return { value: Number(money.replaceAll(",", "")), pattern: "$#,##0.00" };
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) return { value: Number(value.replaceAll(",", "")), pattern: "#,##0" };
  if (/^-?\d+(\.\d+)?$/.test(value)) return { value: Number(value) };
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? [];
  if (year !== undefined && month !== undefined && day !== undefined) {
    return { value: (Date.UTC(+year, +month - 1, +day) - EPOCH) / DAY, pattern: "yyyy-mm-dd" };
  }
  return { value };
}

export const dateOf = (serial: number) => new Date(EPOCH + serial * DAY);

export function emptySheet(name: string): SheetModel {
  return { name, cells: new Map(), widths: new Map(), merges: [], frozenRows: 0, frozenColumns: 0, gridlinesHidden: false };
}

/** Replays the edits in order; an import step adds the sheets read from its File, each new: a taken name gets ` (2)`. */
export function replay({ edits }: Sheet, imported: ImportedSheets = new Map()): Workbook {
  const sheets = new Map<string, SheetModel>();
  for (const [index, edit] of edits.entries()) {
    if (edit.kind === "importFile") {
      const read = imported.get(index);
      if (read === undefined) throw new Error(`Edit ${index} imports ${edit.asset}, which was not read`);
      for (const model of read) {
        let name = model.name;
        for (let n = 2; sheets.has(name); n++) name = `${model.name} (${n})`;
        sheets.set(name, { ...structuredClone(model), name });
      }
      continue;
    }
    let sheet = sheets.get(edit.sheet);
    if (sheet === undefined) sheets.set(edit.sheet, sheet = emptySheet(edit.sheet));
    apply(sheet, edit);
  }
  return { sheets: [...sheets.values()] };
}

function cellAt(sheet: SheetModel, row: number, column: number): Cell {
  const key = `${row},${column}`;
  let cell = sheet.cells.get(key);
  if (cell === undefined) sheet.cells.set(key, cell = { value: null, style: {} });
  return cell;
}

function eachCell(range: string, visit: (row: number, column: number, [r1, c1, r2, c2]: [number, number, number, number]) => void) {
  const bounds = rangeOf(range);
  const [r1, c1, r2, c2] = bounds;
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) visit(r, c, bounds);
}

type Format = Extract<Edit, { kind: "formatCells" }>["format"];

function fontOnto(style: Style, font: NonNullable<Format["font"]>) {
  if (font.bold !== undefined) style.bold = font.bold;
  if (font.italic !== undefined) style.italic = font.italic;
  if (font.underline !== undefined) style.underline = font.underline !== "none";
  if (font.strikethrough !== undefined) style.strike = font.strikethrough;
  if (font.size !== undefined) style.size = font.size;
  if (font.color !== undefined) style.color = hexOf(font.color);
}

function alignmentOnto(style: Style, alignment: NonNullable<Format["alignment"]>) {
  if (alignment.horizontal !== undefined) style.horizontal = alignment.horizontal === "general" ? undefined : alignment.horizontal;
  if (alignment.vertical !== undefined) style.vertical = alignment.vertical;
  if (alignment.wrap !== undefined) style.wrap = alignment.wrap;
}

function formatOnto(style: Style, { font, fillColor, alignment, numberFormat, border }: Format) {
  if (font !== undefined) fontOnto(style, font);
  if (alignment !== undefined) alignmentOnto(style, alignment);
  if (fillColor !== undefined) style.fill = hexOf(fillColor);
  if (numberFormat !== undefined) style.pattern = numberFormat.pattern;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const line = border?.[side];
    if (line !== undefined) style[side] = lineOf(line);
  }
}

function writeCells(sheet: SheetModel, { topLeft, rows }: Extract<Edit, { kind: "writeCells" }>) {
  const [top, left] = cellOf(topLeft);
  rows.forEach((row, i) => row.forEach((value, j) => {
    const cell = cellAt(sheet, top + i, left + j);
    const read = typed(value);
    cell.value = read.value;
    cell.formula = read.formula;
    if (read.pattern) cell.style.pattern = read.pattern;
  }));
}

function sidesOf(edges: Extract<Edit, { kind: "setBorders" }>["edges"], row: number, column: number, [r1, c1, r2, c2]: [number, number, number, number]) {
  const outer = edges === "all" || edges === "outer";
  const inner = edges === "all" || edges === "inner";
  return {
    top: (outer || edges === "top") && row === r1,
    bottom: ((outer || edges === "bottom") && row === r2) || ((inner || edges === "innerHorizontal") && row < r2),
    left: (outer || edges === "left") && column === c1,
    right: ((outer || edges === "right") && column === c2) || ((inner || edges === "innerVertical") && column < c2),
  };
}

function setBorders(sheet: SheetModel, { range, border, edges }: Extract<Edit, { kind: "setBorders" }>) {
  const line = lineOf(border);
  eachCell(range, (r, c, bounds) => {
    const style = cellAt(sheet, r, c).style;
    for (const [side, drawn] of Object.entries(sidesOf(edges, r, c, bounds)) as [keyof ReturnType<typeof sidesOf>, boolean][]) {
      if (drawn) style[side] = line;
    }
  });
}

function fitColumn(sheet: SheetModel, column: number): number {
  let width = 40;
  for (const [key, cell] of sheet.cells) {
    if (keyOf(key)[1] !== column || cell.style.wrap) continue;
    const shown = cell.formula !== undefined ? "0000.0" : cell.style.pattern ?? String(cell.value ?? "");
    width = Math.max(width, Math.min(360, shown.length * 7.5 + 16));
  }
  return Math.round(width);
}

function setSheetSettings(sheet: SheetModel, { settings }: Extract<Edit, { kind: "setSheetSettings" }>) {
  const { lastFrozenRow, lastFrozenColumn, areGridlinesHidden } = settings;
  if (lastFrozenRow !== undefined) sheet.frozenRows = lastFrozenRow ?? 0;
  if (lastFrozenColumn !== undefined) sheet.frozenColumns = lastFrozenColumn === null ? 0 : columnIndex(lastFrozenColumn) + 1;
  if (areGridlinesHidden !== undefined) sheet.gridlinesHidden = areGridlinesHidden;
}

function apply(sheet: SheetModel, edit: Exclude<Edit, { kind: "importFile" }>) {
  switch (edit.kind) {
    case "writeCells":
      return writeCells(sheet, edit);
    case "formatCells":
      for (const range of edit.ranges) eachCell(range, (r, c) => formatOnto(cellAt(sheet, r, c).style, edit.format));
      return;
    case "setBorders":
      return setBorders(sheet, edit);
    case "setColumnWidths": {
      const [from, to] = columnsOf(edit.columns);
      for (let c = from; c <= to; c++) sheet.widths.set(c, edit.widthInPixels);
      return;
    }
    case "fitColumns": {
      const [from, to] = columnsOf(edit.columns);
      for (let c = from; c <= to; c++) sheet.widths.set(c, fitColumn(sheet, c));
      return;
    }
    case "setSheetSettings":
      return setSheetSettings(sheet, edit);
    case "mergeCells":
      for (const range of edit.ranges) sheet.merges.push(rangeOf(range));
      return;
    case "setCellTable":
      // A table's banded and footer rows need a Univer plugin outside its open-source core.
      return;
  }
}

/** Univer's border styles by line style (its `BorderStyleTypes`). */
const BORDER: Record<NonNullable<Line>["style"], number> = { thin: 1, dotted: 3, dashed: 4, double: 7, medium: 8, thick: 13 };
const HORIZONTAL = { left: 1, center: 2, right: 3 } as const;
const VERTICAL = { top: 1, center: 2, bottom: 3 } as const;

const univerBorder = (line: Line | undefined) => line ? { s: BORDER[line.style], cl: { rgb: line.color } } : undefined;
const flag = (on: boolean) => on ? 1 : 0;

/** A cell's style as Univer's (`IStyleData`). */
function univerStyleOf(style: Style): Record<string, unknown> {
  const { bold, italic, underline, strike, size, color, fill, horizontal, vertical, wrap, pattern } = style;
  return {
    ...(bold !== undefined && { bl: flag(bold) }),
    ...(italic !== undefined && { it: flag(italic) }),
    ...(underline !== undefined && { ul: { s: flag(underline) } }),
    ...(strike !== undefined && { st: { s: flag(strike) } }),
    ...(size !== undefined && { fs: size }),
    ...(color !== undefined && { cl: { rgb: color } }),
    ...(fill !== undefined && { bg: { rgb: fill } }),
    ...(horizontal !== undefined && { ht: HORIZONTAL[horizontal] }),
    ...(vertical !== undefined && { vt: VERTICAL[vertical] }),
    ...(wrap && { tb: 3 }),
    ...(pattern !== undefined && { n: { pattern } }),
    bd: { t: univerBorder(style.top), r: univerBorder(style.right), b: univerBorder(style.bottom), l: univerBorder(style.left) },
  };
}

/** A cell as Univer's (`ICellData`), its style by id. */
function univerCellOf(cell: Cell, styleId: string): Record<string, unknown> {
  const value = typeof cell.value === "boolean" ? { v: flag(cell.value), t: 3 } : cell.value === null ? {} : { v: cell.value };
  return { ...value, ...(cell.formula !== undefined && { f: `=${cell.formula}` }), s: styleId };
}

function univerSheetOf(sheet: SheetModel, id: string, styles: Record<string, unknown>): Record<string, unknown> {
  const cellData: Record<number, Record<number, unknown>> = {};
  let rows = 100, columns = 26;
  for (const [key, cell] of sheet.cells) {
    const [r, c] = keyOf(key);
    rows = Math.max(rows, r + 20);
    columns = Math.max(columns, c + 5);
    const styleId = `${id}-${key}`;
    styles[styleId] = univerStyleOf(cell.style);
    (cellData[r] ??= {})[c] = univerCellOf(cell, styleId);
  }
  return {
    id, name: sheet.name, rowCount: rows, columnCount: columns, cellData,
    mergeData: sheet.merges.map(([r1, c1, r2, c2]) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 })),
    columnData: Object.fromEntries([...sheet.widths].map(([c, w]) => [c, { w }])),
    freeze: { xSplit: sheet.frozenColumns, ySplit: sheet.frozenRows, startRow: sheet.frozenRows, startColumn: sheet.frozenColumns },
    showGridlines: sheet.gridlinesHidden ? 0 : 1,
  };
}

/** The workbook as Univer's workbook data (`IWorkbookData`), each cell with its own style. */
export function univerDataOf(book: Workbook): Record<string, unknown> {
  const styles: Record<string, unknown> = {};
  const sheets = Object.fromEntries(book.sheets.map((sheet, i) => [`sheet-${i}`, univerSheetOf(sheet, `sheet-${i}`, styles)]));
  return { id: "workbook", name: "Sheet", appVersion: "0.1.0", locale: "enUS", styles, sheetOrder: Object.keys(sheets), sheets };
}

export type UniverCells = Pick<IWorkbookData, "sheets">;

/**
 * The User's changes in the grid as `writeCells` edits, one per changed cell, each written as it would be typed: a
 * formula with its `=`, a number as a number, and text that would read as something else kept with a leading `'`.
 * Only values: a look the User changed in the grid is not saved.
 */
export function editsOf(book: Workbook, grid: UniverCells): Edit[] {
  return Object.entries(grid.sheets).flatMap(([id, { name, cellData = {} }]) => {
    if (name === undefined) throw new Error(`Univer saved sheet ${id} without its name`);
    return sheetEditsOf(name, book.sheets.find((known) => known.name === name), cellData);
  });
}

function sheetEditsOf(name: string, sheet: SheetModel | undefined, cellData: Record<number, Record<number, ICellData | undefined>>): Edit[] {
  const edits: Edit[] = [];
  const write = (r: number, c: number, value: CellValue) => edits.push({ kind: "writeCells", sheet: name, topLeft: address(r, c), rows: [[value]] });
  const seen = new Set<string>();
  for (const [r, row] of Object.entries(cellData)) for (const [c, cell] of Object.entries<ICellData | undefined>(row)) {
    const key = `${r},${c}`;
    seen.add(key);
    const now = typedOf(cell);
    if (now !== typedOf(sheet?.cells.get(key))) write(Number(r), Number(c), now);
  }
  for (const [key, cell] of sheet?.cells ?? []) {
    if (!seen.has(key) && typedOf(cell) !== null) write(...keyOf(key), null);
  }
  return edits;
}

function typedOf(cell: Cell | ICellData | undefined): CellValue {
  if (cell === undefined) return null;
  if ("style" in cell) {
    if (cell.formula !== undefined) return `=${cell.formula}`;
    return typeof cell.value === "string" && typed(cell.value).value !== cell.value ? `'${cell.value}` : cell.value;
  }
  if (cell.f) return cell.f;
  if (cell.v === undefined || cell.v === null || cell.v === "") return null;
  if (cell.t === 3) return cell.v === 1 || cell.v === true;
  if (typeof cell.v === "number") return cell.v;
  const text = typeof cell.v === "string" ? cell.v : JSON.stringify(cell.v);
  return typed(text).value !== text || text.startsWith("'") ? `'${text}` : text;
}
