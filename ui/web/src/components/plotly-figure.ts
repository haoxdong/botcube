/**
 * A Plotly figure the agent saved with `fig.write_json('<name>.plotly.json')`, read as data and never as code:
 * only its `data` and `layout` are kept, so the agent's `config` and `frames` never reach plotly.js.
 */
export interface Figure {
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
}

/** Whether a file, by its name, is a Plotly figure: drawn as a live chart inline in a reply and in Files. */
export const isFigureName = (name: string) => name.toLowerCase().endsWith('.plotly.json');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Text that would run as script if plotly.js drew it as a label's or a link's markup. */
const SCRIPT = /<\s*script|javascript\s*:/i;

function refuseScripts(value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (SCRIPT.test(value)) throw new Error(`the chart carries a script at ${where}`);
  } else if (Array.isArray(value)) value.forEach((item, index) => refuseScripts(item, `${where}[${index}]`));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) refuseScripts(item, `${where}.${key}`);
}

/**
 * The figure in `text`, checked: it is the JSON of an object with a `data` list of traces, and no text in it carries a
 * script. Throws, saying why, for anything else.
 */
export function parseFigure(text: string): Figure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (failure) {
    throw new Error(`the chart is not JSON (${failure instanceof Error ? failure.message : String(failure)})`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data) || !parsed.data.every(isRecord))
    throw new Error('the chart has no list of traces under "data"');
  const layout = isRecord(parsed.layout) ? { ...parsed.layout } : {};
  refuseScripts(parsed.data, 'data');
  refuseScripts(layout, 'layout');
  return { data: parsed.data, layout };
}
