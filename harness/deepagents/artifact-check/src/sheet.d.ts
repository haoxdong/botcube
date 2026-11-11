export type Hue = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'magenta';
export type Color = { kind: 'none' } | { kind: 'rgb'; hex: string } | { kind: 'standard'; hue: Hue; shade: 100 | 200 | 300 | 400 | 600 | 800 };
export type Line = { kind: 'none' } | { kind: 'line'; style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double'; color: Color };
export type CellValue = string | number | boolean | null;
export type Format = {
  numberFormat?: { pattern: string };
  alignment?: { horizontal?: 'general' | 'left' | 'center' | 'right'; vertical?: 'top' | 'center' | 'bottom'; wrap?: boolean };
  fillColor?: Color;
  cellControl?: { kind: 'none' };
  border?: { top?: Line; right?: Line; bottom?: Line; left?: Line };
  font?: { bold?: boolean; italic?: boolean; underline?: 'none' | 'single' | 'double'; strikethrough?: boolean; size?: number; color?: Color };
};
export type Edit =
  | { kind: 'writeCells'; sheet: string; topLeft: string; rows: CellValue[][] }
  | { kind: 'formatCells'; sheet: string; ranges: string[]; format: Format }
  | { kind: 'setBorders'; sheet: string; range: string; edges: 'all' | 'inner' | 'innerHorizontal' | 'innerVertical' | 'outer' | 'left' | 'top' | 'right' | 'bottom'; border: Line }
  | { kind: 'setColumnWidths'; sheet: string; columns: string; widthInPixels: number }
  | { kind: 'fitColumns'; sheet: string; columns: string }
  | { kind: 'setSheetSettings'; sheet: string; settings: { lastFrozenRow?: number | null; lastFrozenColumn?: string | null; areGridlinesHidden?: boolean } }
  | { kind: 'mergeCells'; sheet: string; ranges: string[] }
  | { kind: 'setCellTable'; sheet: string; cellTable: null }
  | { kind: 'importFile'; asset: string };
export type Sheet = { edits: Edit[] };
/** Every error in a Sheet, given its one file by its name; each names the edit's index and kind, the field and the nearest allowed form. */
export function checkSheet(files: Record<string, string>): Promise<import('botcube-artifact-check').CheckError[]>;
