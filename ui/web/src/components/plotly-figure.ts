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
 * script. A layout image loads only from the file itself (a `data:image/` source); one from anywhere else is dropped,
 * so drawing the chart fetches nothing. Throws, saying why, for anything else.
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
  if (Array.isArray(layout.images))
    layout.images = layout.images.filter(
      (image) => isRecord(image) && typeof image.source === 'string' && image.source.startsWith('data:image/'),
    );
  return { data: parsed.data, layout };
}

const X_AXIS = /^xaxis\d*$/;

/** Below this width a chart is a phone's: its x ticks stay level and fewer, so no label runs into the next. */
const NARROW = 480;

/**
 * A phone's x ticks for its box's width: room for one long label (a category such as "North America" at 13px), then
 * one tick per `TICK_SPACING`, so no label runs into the next.
 */
const LONG_LABEL = 90;
const TICK_SPACING = 60;

/** A phone's date labels by tick spacing: `Jan '24` for months, `2024` for years; plotly's own below a month. */
const SHORT_DATES = [
  { dtickrange: ['M1', 'M12'], value: "%b '%y" },
  { dtickrange: ['M12', null], value: '%Y' },
];

/** A note the agent put under the plot (paper y below 0), which the chart shows as a caption under its box instead. */
const isBelowPlot = (note: unknown): note is Record<string, unknown> =>
  isRecord(note) && note.yref === 'paper' && typeof note.y === 'number' && note.y < 0;

/** Plotly text as plain lines: plotly's `<br>` breaks a line, and its other markup (`<b>`, `<a>`, …) is dropped. */
const plainText = (text: unknown) =>
  (typeof text === 'string' ? text : '')
    .split(/<br\s*\/?>/i)
    .map((line) => line.replace(/<[^>]*>/g, '').trim())
    .filter((line) => line !== '')
    .join('\n');

const textOf = (value: unknown) => plainText(isRecord(value) ? value.text : value);

/**
 * The figure's title and its subtitle (the agent's source line) as plain text, for the page to set above the chart in
 * its own type, where a long title wraps to the box's width; plotly draws a title as one SVG line that never wraps.
 */
export function headingOf(layout: Record<string, unknown>): { title: string; subtitle: string } {
  const { title } = layout;
  return { title: textOf(title), subtitle: isRecord(title) ? textOf(title.subtitle) : '' };
}

/**
 * The notes the agent put under the plot, such as its source line, as plain text for a caption under the chart:
 * placed by the page rather than by plotly, a caption never sits over a tick label and the card is as tall as it needs.
 */
export function notesUnder(layout: Record<string, unknown>): string[] {
  return Array.isArray(layout.annotations) ? layout.annotations.filter(isBelowPlot).map((note) => plainText(note.text)) : [];
}

/**
 * An agent's fixed x ticks undone, so plotly's own spacing (`nticks`) holds: a tick every month (`dtick: 'M1'`) labelled
 * `%b %Y` ran six labels into one another on a phone. Plotly's own date labels give the year once.
 */
function autoTicks(agent: Record<string, unknown>, width: number): Record<string, unknown> {
  const { dtick: _dtick, tick0: _tick0, tickmode, tickformat, ...rest } = agent;
  return {
    ...rest,
    ...(tickmode === 'array' ? { tickmode } : { tickmode: 'auto' }),
    ...(typeof tickformat === 'string' && !tickformat.includes('%') ? { tickformat } : {}),
    tickangle: 0,
    nticks: Math.min(4, Math.max(2, Math.floor((width - LONG_LABEL) / TICK_SPACING))),
    tickformatstops: SHORT_DATES,
  };
}

/**
 * The figure's layout fitted to its box, its look left to the figure's own template (the Harness's default is
 * BotCube's, DESIGN.md Charts): transparent backgrounds over the reply, tight margins that grow only as the axes need,
 * the legend in a row over the plot so the plot takes the box's width, and no title, which the page sets above
 * (`headingOf`). Notes under the plot leave the layout for a caption (`notesUnder`). At a phone's `width`, the x ticks
 * are plotly's own, level and fewer.
 */
export function fittedLayout(layout: Record<string, unknown>, width: number): Record<string, unknown> {
  const { width: _width, height: _height, margin: _margin, title: _title, ...own } = layout;
  const xAxes = width < NARROW ? [...new Set(['xaxis', ...Object.keys(own).filter((key) => X_AXIS.test(key))])] : [];
  return {
    ...own,
    ...Object.fromEntries(xAxes.map((key) => [key, autoTicks(isRecord(own[key]) ? own[key] : {}, width)])),
    ...(Array.isArray(own.annotations) ? { annotations: own.annotations.filter((note) => !isBelowPlot(note)) } : {}),
    // A row over the plot, rather than a column beside it that takes the width.
    legend: { ...(isRecord(own.legend) ? own.legend : {}), orientation: 'h', x: 0, xanchor: 'left', y: 1, yanchor: 'bottom' },
    margin: { l: 4, r: 8, t: 8, b: 4, pad: 0 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    autosize: true,
  };
}
