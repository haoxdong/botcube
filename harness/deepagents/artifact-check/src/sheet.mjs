// The Sheet format: one JSON file `{"edits": [...]}` whose edits are claude.ai's own sheet edits, with their kinds, keys
// and values exactly. It takes the nine kinds below; any other kind is refused by name, and so is a key under another
// name or a key too many. What the grid or the Excel file would drop is refused too, naming the edit and the field: a
// checkbox, a table (its banded rows and footer rows), and a merge overlapping another, which Excel can't write. A
// formula is a string like any other value, so its text is not checked: a range Excel can't read (`F2:F`) passes here
// and shows as an error in the grid.
import { z } from 'zod';

/** @typedef {import('./check.mjs').CheckError} CheckError */

// Excel's own rule for a sheet's name, which the Excel file must keep.
const sheet = z.string().min(1).max(31).regex(/^[^[\]:*?/\\]*$/);
const range = z.string().regex(/^[A-Z]+\d+(:[A-Z]+\d+)?$/);
const columns = z.string().regex(/^[A-Z]+(:[A-Z]+)?$/);
const hex = z.string().regex(/^#[0-9a-f]{6}$/);
const color = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('rgb'), hex }),
  z.strictObject({
    kind: z.literal('standard'),
    hue: z.enum(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'magenta']),
    shade: z.union([100, 200, 300, 400, 600, 800].map((shade) => z.literal(shade))),
  }),
]);
const line = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('line'), style: z.enum(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double']), color }),
]);
// A cell's value: a string is read as if typed (`=` a formula, `50%` a percent, a leading `'` keeps text); null clears.
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const format = z.strictObject({
  numberFormat: z.strictObject({ pattern: z.string() }).optional(),
  alignment: z.strictObject({
    horizontal: z.enum(['general', 'left', 'center', 'right']).optional(),
    vertical: z.enum(['top', 'center', 'bottom']).optional(),
    wrap: z.boolean().optional(),
  }).optional(),
  fillColor: color.optional(),
  // Neither the grid (Univer's open-source core) nor the Excel file draws a checkbox, so only `none` is taken for now.
  cellControl: z.strictObject({ kind: z.literal('none') }).optional(),
  border: z.strictObject({ top: line.optional(), right: line.optional(), bottom: line.optional(), left: line.optional() }).optional(),
  font: z.strictObject({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.enum(['none', 'single', 'double']).optional(),
    strikethrough: z.boolean().optional(),
    size: z.number().int().min(6).max(96).optional(),
    color: color.optional(),
  }).optional(),
});

/** Each edit kind a Sheet takes, by name. */
export const EDITS = {
  writeCells: z.strictObject({ kind: z.literal('writeCells'), sheet, topLeft: range, rows: z.array(z.array(cell)).min(1) }),
  formatCells: z.strictObject({ kind: z.literal('formatCells'), sheet, ranges: z.array(range).min(1), format }),
  setBorders: z.strictObject({
    kind: z.literal('setBorders'), sheet, range,
    edges: z.enum(['all', 'inner', 'innerHorizontal', 'innerVertical', 'outer', 'left', 'top', 'right', 'bottom']), border: line,
  }),
  setColumnWidths: z.strictObject({ kind: z.literal('setColumnWidths'), sheet, columns, widthInPixels: z.number().min(8).max(2000) }),
  fitColumns: z.strictObject({ kind: z.literal('fitColumns'), sheet, columns }),
  setSheetSettings: z.strictObject({
    kind: z.literal('setSheetSettings'), sheet,
    settings: z.strictObject({
      lastFrozenRow: z.number().int().min(0).nullable().optional(),
      lastFrozenColumn: z.string().regex(/^[A-Z]+$/).nullable().optional(),
      areGridlinesHidden: z.boolean().optional(),
    }),
  }),
  mergeCells: z.strictObject({ kind: z.literal('mergeCells'), sheet, ranges: z.array(range).min(1) }),
  // A table bands its rows and may total them in footer rows; neither the grid nor the Excel file has either yet, so
  // only `null` (no table) is taken. The fields stay so a table's own errors are named before it is refused.
  setCellTable: z.strictObject({
    kind: z.literal('setCellTable'), sheet,
    cellTable: z.strictObject({ columns, headerRows: z.string(), footerRows: z.null() }).nullable().refine((table) => table === null),
  }),
  // That the File is in Files is the publish's check, which keeps a copy of it with the version.
  importFile: z.strictObject({ kind: z.literal('importFile'), asset: z.string().regex(/^[^\0]+\.(xlsx|csv)$/i) }),
};

const KINDS = Object.keys(EDITS);
const NO_TABLE = 'cellTable null; for a header row, bold it with formatCells and freeze it with setSheetSettings lastFrozenRow';

/** The allowed form at a field, by its last named key (or what it is in), for an error's "Nearest". */
const NEAREST = {
  sheet: 'a sheet name of 1 to 31 characters with none of [ ] : * ? / \\',
  topLeft: 'one cell such as B2', range: 'a range such as A1:C4, or one cell such as B2', ranges: 'ranges such as ["A1:C4", "B2"]',
  columns: 'columns such as B:C, or one column such as B', lastFrozenColumn: 'a column such as B',
  hex: 'a hex color: # and six lowercase digits, such as #1f2937', rows: 'rows of cells: [["Item", 1200, "=SUM(B2:B3)", true, null]]',
  cellControl: '{"kind": "none"}: write true or false in the cells instead of a checkbox',
  footerRows: 'no table yet (cellTable null), with the totals written as cells by writeCells',
  cellTable: NO_TABLE,
  color: '{"kind": "none"}, {"kind": "rgb", "hex": "#1f2937"} or {"kind": "standard", "hue": "blue", "shade": 600}',
  fillColor: '{"kind": "none"}, {"kind": "rgb", "hex": "#1f2937"} or {"kind": "standard", "hue": "blue", "shade": 600}',
  border: '{"kind": "none"} or {"kind": "line", "style": "thin", "color": {"kind": "none"}}',
  asset: 'an .xlsx or a .csv File in Files, such as /data/orders.xlsx',
  widthInPixels: 'a width of 8 to 2000 pixels', size: 'a whole font size from 6 to 96',
};

const at = (path) => path.map((key) => typeof key === 'number' ? `[${key}]` : `.${key}`).join('').replace(/^\./, '') || 'the edit';

function nearestOf(kind, issue) {
  const named = issue.path.findLast((key) => typeof key === 'string' && Object.hasOwn(NEAREST, key));
  if (issue.code !== 'unrecognized_keys' && named !== undefined) return NEAREST[named];
  return `the keys of ${issue.path.length === 0 ? kind : at(issue.path)}: ${keysOf(kind, issue.path)}`;
}

/** The keys the object at `path` in an edit of `kind` takes. */
function keysOf(kind, path) {
  let schema = EDITS[kind];
  for (const key of path) {
    while (schema.unwrap !== undefined && schema.shape === undefined) schema = schema.unwrap();
    schema = schema.shape?.[key] ?? schema.element ?? schema.options?.find((option) => option.shape[key])?.shape[key] ?? schema;
  }
  while (schema.unwrap !== undefined && schema.shape === undefined) schema = schema.unwrap();
  const shapes = schema.shape === undefined ? (schema.options ?? []).map((option) => option.shape) : [schema.shape];
  return [...new Set(shapes.flatMap((shape) => Object.keys(shape)))].join(', ');
}

function messageOf(issue, value) {
  const field = at(issue.path);
  if (issue.code === 'unrecognized_keys') return `${field} has ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}, a key it does not take`;
  const found = issue.path.reduce((inside, key) => inside?.[key], value);
  if (found === undefined) return `${field} is missing`;
  const last = issue.path.at(-1);
  if (last === 'cellControl' || issue.path.at(-2) === 'cellControl') return `${field} is ${JSON.stringify(found)}, which neither the grid nor the Excel file draws yet`;
  if (last === 'footerRows') return `${field} is ${JSON.stringify(found)}: footer rows are a table's, which neither the grid nor the Excel file draws yet`;
  if (last === 'sheet') return `${field} is ${JSON.stringify(found)}, which Excel does not take as a sheet's name`;
  if (last === 'cellTable') return `${field} is a table, whose banded rows neither the grid nor the Excel file draws yet`;
  return `${field} is ${JSON.stringify(found)}, which it does not take`;
}

/** Every error in one Sheet file's text, named by `file`; an empty list when it may be saved. */
function checkText(file, text) {
  const error = (element, message, nearest) => ({ file, element, message, nearest });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (thrown) {
    return [error('the Sheet', `is not JSON (${String(thrown.message).replace(/\.$/, '')})`, '{"edits": [...]}')];
  }
  const whole = z.strictObject({ edits: z.array(z.unknown()) }).safeParse(parsed);
  if (!whole.success) return [error('the Sheet', 'is not {"edits": [...]}', '{"edits": [...]} and nothing else')];
  const merged = [];
  return whole.data.edits.flatMap((raw, index) => {
    const kind = raw?.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(EDITS, kind)) {
      return [error(`edit ${index}`, `kind ${JSON.stringify(kind)} is not one a Sheet takes`, `one of ${KINDS.join(', ')}`)];
    }
    const result = EDITS[kind].safeParse(raw);
    if (!result.success) {
      return result.error.issues.map((issue) => error(`edit ${index} (${kind})`, messageOf(issue, raw), nearestOf(kind, issue)));
    }
    if (kind !== 'mergeCells') return [];
    return result.data.ranges.flatMap((range, position) => {
      const merge = { sheet: result.data.sheet, range, index, bounds: boundsOf(range) };
      const earlier = merged.find((other) => other.sheet === merge.sheet && overlap(other.bounds, merge.bounds));
      if (earlier === undefined) {
        merged.push(merge);
        return [];
      }
      return [error(
        `edit ${index} (mergeCells)`,
        `ranges[${position}] is "${range}", which overlaps "${earlier.range}" merged by edit ${earlier.index}, and Excel can't merge a cell twice`,
        `one merge that covers both, such as "${spanOf(earlier.bounds, merge.bounds)}", or a range that shares no cell with "${earlier.range}"`,
      )];
    });
  });
}

const columnOf = (letters) => [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
const letterOf = (column) => column <= 26 ? String.fromCharCode(64 + column) : letterOf(Math.floor((column - 1) / 26)) + letterOf((column - 1) % 26 + 1);

function boundsOf(range) {
  const [first, last = first] = range.split(':').map((cell) => {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(cell);
    return [Number(row), columnOf(letters)];
  });
  return [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.max(first[0], last[0]), Math.max(first[1], last[1])];
}

const overlap = ([r1, c1, r2, c2], [s1, d1, s2, d2]) => r1 <= s2 && s1 <= r2 && c1 <= d2 && d1 <= c2;

const spanOf = ([r1, c1, r2, c2], [s1, d1, s2, d2]) =>
  `${letterOf(Math.min(c1, d1))}${Math.min(r1, s1)}:${letterOf(Math.max(c2, d2))}${Math.max(r2, s2)}`;

/**
 * Every error in a Sheet, given its one file by its name (`budget.sheet.json`); each names the edit's index and kind,
 * the field, and the nearest allowed form. An empty list means the Sheet may be saved.
 * @param {Record<string, string>} files
 * @returns {Promise<CheckError[]>}
 */
export async function checkSheet(files) {
  const entries = Object.entries(files);
  if (entries.length !== 1) {
    return [{ file: entries.map(([name]) => name).join(', ') || '(none)', element: 'the Sheet', message: `is ${entries.length} files`, nearest: 'one <name>.sheet.json file' }];
  }
  const [[file, text]] = entries;
  return checkText(file, text);
}
