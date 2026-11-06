import { render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PlotlyChart } from './plotly-chart';

// plotly.js's prebuilt bundle, which happy-dom cannot draw with: some of its trace types, drawing as `react` settles.
const plotly = vi.hoisted(() => ({
  react: vi.fn(async () => undefined),
  purge: vi.fn(),
  Plots: { resize: vi.fn(async () => undefined) },
  PlotSchema: { get: () => ({ traces: { scatter: {}, candlestick: {}, sankey: {}, heatmap: {} } }) },
}));
vi.mock('./plotly-bundle', () => ({ default: async () => plotly }));

beforeEach(() => plotly.react.mockClear());

it.each([
  ['candlestick', '{"type":"candlestick","x":["2026-10-28"],"open":[72],"high":[73.5],"low":[71],"close":[71.5]}'],
  ['sankey', '{"type":"sankey","node":{"label":["A","B"]},"link":{"source":[0],"target":[1],"value":[1]}}'],
])('draws a %s from plotly.js’s one prebuilt bundle', async (type, trace) => {
  const view = render(<PlotlyChart text={`{"data":[${trace}]}`} title={type} />);
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  expect((plotly.react.mock.calls[0] as unknown[])[1]).toEqual([JSON.parse(trace)]);
  expect(view.queryByRole('alert')).toBeNull();
});

it('names a trace type plotly.js does not have, which plotly would draw as an empty plot', async () => {
  const view = render(<PlotlyChart text='{"data":[{"y":[1]},{"type":"sunrise"},{"type":"moonrise"}]}' title="Sky" />);
  expect(await view.findByRole('alert')).toHaveTextContent('Sky could not draw: plotly.js has no "sunrise", "moonrise" chart type');
  expect(plotly.react).not.toHaveBeenCalled();
});

it('redraws at the box\u2019s width whenever the box resizes, so a chart never runs past its bubble', async () => {
  const observed: { callback: () => void; targets: Element[] }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    readonly entry: { callback: () => void; targets: Element[] };
    constructor(callback: () => void) {
      this.entry = { callback, targets: [] };
      observed.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    disconnect() { this.entry.targets = []; }
  });
  plotly.Plots.resize.mockClear();
  const view = render(<PlotlyChart text='{"data":[{"y":[1,2]}]}' title="Line" />);
  const chart = (await view.findByRole('figure', { name: 'Line' })).querySelector('.plotly-chart');
  await waitFor(() => expect(observed.at(-1)?.targets).toEqual([chart]));
  observed.at(-1)?.callback();
  expect(plotly.Plots.resize).toHaveBeenCalledWith(chart);
  // plotly.js rejects a resize of a chart that is not displayed, as WebKit logged when a chart's box was hidden.
  plotly.Plots.resize.mockClear();
  (chart as HTMLElement).style.display = 'none';
  observed.at(-1)?.callback();
  expect(plotly.Plots.resize).not.toHaveBeenCalled();
  view.unmount();
  expect(observed.at(-1)?.targets).toEqual([]);
  vi.unstubAllGlobals();
});

it('shows the notes under the plot as a caption under the chart, not in it', async () => {
  plotly.react.mockClear();
  const view = render(<PlotlyChart text='{"data":[{"y":[1,2]}],"layout":{"annotations":[{"text":"Source: user-provided values","xref":"paper","yref":"paper","x":0,"y":-0.2}]}}' title="CPI" />);
  const figure = await view.findByRole('figure', { name: 'CPI' });
  expect(figure.querySelector('.plotly-chart-note')).toHaveTextContent('Source: user-provided values');
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  expect((plotly.react.mock.calls[0] as unknown[])[2]).toMatchObject({ annotations: [] });
});

it('sets the title and its source above the chart as text, and leaves plotly no title to draw', async () => {
  plotly.react.mockClear();
  const view = render(<PlotlyChart text='{"data":[{"y":[1,2]}],"layout":{"title":{"text":"US 10-year Treasury yield since 2020, daily close","subtitle":{"text":"Source: FRED"}}}}' title="Yield" />);
  const figure = await view.findByRole('figure', { name: 'Yield' });
  expect(figure.querySelector('.plotly-chart-title')).toHaveTextContent('US 10-year Treasury yield since 2020, daily close');
  expect(figure.querySelector('.plotly-chart-subtitle')).toHaveTextContent('Source: FRED');
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  expect((plotly.react.mock.calls[0] as unknown[])[2]).not.toHaveProperty('title');
});
