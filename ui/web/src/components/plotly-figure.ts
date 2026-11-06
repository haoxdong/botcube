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

/** The app's colours a chart is drawn in, as tokens.css resolves them. */
export interface ChartPalette {
  text: string;
  muted: string;
  line: string;
  white: string;
  font: string;
}

const AXIS = /^[xy]axis\d*$/;

/** Below this width a chart is a phone's: its x ticks stay level and fewer, so no label runs into the next. */
const NARROW = 480;

const textOf = (value: unknown) => (isRecord(value) ? value.text : value);

/** A note the agent put under the plot (paper y below 0), which the chart shows as a caption under its box instead. */
const isBelowPlot = (note: unknown): note is Record<string, unknown> =>
  isRecord(note) && note.yref === 'paper' && typeof note.y === 'number' && note.y < 0;

/** A note's text as plain lines: plotly's `<br>` breaks a line, and its other markup (`<b>`, `<a>`, …) is dropped. */
const plainLines = (text: unknown) =>
  (typeof text === 'string' ? text : '')
    .split(/<br\s*\/?>/i)
    .map((line) => line.replace(/<[^>]*>/g, '').trim())
    .filter((line) => line !== '');

/**
 * The notes the agent put under the plot, such as its source line, as plain text for a caption under the chart:
 * placed by the page rather than by plotly, a caption never sits over a tick label and the card is as tall as it needs.
 */
export function notesUnder(layout: Record<string, unknown>): string[] {
  return Array.isArray(layout.annotations) ? layout.annotations.filter(isBelowPlot).map((note) => plainLines(note.text).join('\n')) : [];
}

type Fonts = { font: { family: string; color: string }; muted: { family: string; color: string } };

const withFont = (set: unknown, font: Fonts['font']) => ({ ...(isRecord(set) ? set : {}), ...font });

/**
 * An agent's fixed x ticks undone, so plotly's own spacing (`nticks`) holds: a tick every month (`dtick: 'M1'`) labelled
 * `%b %Y` ran six labels into one another on a phone. Plotly's own date labels give the year once.
 */
function autoTicks(agent: Record<string, unknown>): Record<string, unknown> {
  const { dtick: _dtick, tick0: _tick0, tickmode, tickformat, ...rest } = agent;
  return {
    ...rest,
    ...(tickmode === 'array' ? { tickmode } : { tickmode: 'auto' }),
    ...(typeof tickformat === 'string' && !tickformat.includes('%') ? { tickformat } : {}),
    tickangle: 0,
    nticks: 4,
  };
}

/** An axis in the app's look: token lines, muted ticks, its title in the text colour; plotly's own, level x ticks on a phone. */
function themedAxis(key: string, set: unknown, palette: ChartPalette, fonts: Fonts, narrow: boolean) {
  const raw = isRecord(set) ? set : {};
  const agent = narrow && key.startsWith('x') ? autoTicks(raw) : raw;
  const title = isRecord(agent.title) ? agent.title : agent.title === undefined ? undefined : { text: agent.title };
  return {
    ...agent,
    gridcolor: palette.line,
    linecolor: palette.line,
    zerolinecolor: palette.line,
    automargin: true,
    tickfont: withFont(agent.tickfont, fonts.muted),
    ...(title === undefined ? {} : { title: { ...title, font: withFont(title.font, fonts.font) } }),
  };
}

const hasText = (value: unknown) => {
  const text = textOf(value);
  return text !== undefined && text !== '';
};

/**
 * The figure's layout in the app's look: the app's font and text colour, token grid lines and hover label,
 * transparent backgrounds over the reply, tight margins that grow only as the axes need, and the legend in a row over
 * the plot, so the plot takes the box's width. The agent's own trace colours stay, plotly.py's template colorway
 * included, while the rest of that template (its grey plot area and white grid) is dropped. Notes under the plot leave
 * the layout for a caption (`notesUnder`). At a phone's `width`, the x ticks are plotly's own, level and fewer.
 */
export function themedLayout(
  layout: Record<string, unknown>,
  palette: ChartPalette,
  width: number,
): Record<string, unknown> {
  const { template, width: _width, height: _height, margin: _margin, ...own } = layout;
  const fonts: Fonts = { font: { family: palette.font, color: palette.text }, muted: { family: palette.font, color: palette.muted } };
  const axisKeys = [...new Set(['xaxis', 'yaxis', ...Object.keys(own).filter((key) => AXIS.test(key))])];
  const axes = Object.fromEntries(axisKeys.map((key) => [key, themedAxis(key, own[key], palette, fonts, width < NARROW)]));
  const title = isRecord(own.title) ? own.title : typeof own.title === 'string' ? { text: own.title } : undefined;
  const titled = title !== undefined && hasText(title);
  const templateLayout = isRecord(template) && isRecord(template.layout) ? template.layout : {};
  const colorway = own.colorway ?? templateLayout.colorway;
  return {
    hoverlabel: { bgcolor: palette.white, bordercolor: palette.line, font: fonts.font },
    ...own,
    ...axes,
    ...(Array.isArray(own.annotations) ? { annotations: own.annotations.filter((note) => !isBelowPlot(note)) } : {}),
    ...(colorway === undefined ? {} : { colorway }),
    ...(titled ? { title: { ...title, x: 0, xanchor: 'left', font: withFont(title.font, fonts.font) } } : {}),
    // A row over the plot, rather than a column beside it that takes the width.
    legend: { ...(isRecord(own.legend) ? own.legend : {}), orientation: 'h', x: 0, xanchor: 'left', y: 1, yanchor: 'bottom', font: fonts.font },
    margin: { l: 4, r: 8, t: titled ? 40 : 8, b: 4, pad: 0 },
    font: withFont(own.font, fonts.font),
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    autosize: true,
  };
}
