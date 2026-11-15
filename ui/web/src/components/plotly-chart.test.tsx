import assert from 'node:assert/strict';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PlotlyChart } from './plotly-chart';

// plotly.js's prebuilt bundle, which happy-dom cannot draw with: some of its trace types, drawing as `react` settles.
const plotly = vi.hoisted(() => ({
  react: vi.fn(async () => undefined),
  purge: vi.fn<(element: HTMLElement) => void>(),
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

it('passes titles, annotations, shapes and layout dimensions to Plotly unchanged', async () => {
  const layout = {
    title: { text: 'US Treasury yield', subtitle: { text: 'Source: FRED' } },
    annotations: [{ text: 'Source', xref: 'paper', yref: 'paper', x: 0, y: -0.2 }],
    shapes: [{ type: 'line', x0: 0, x1: 1, y0: 2, y1: 2 }],
    width: 700, height: 850, margin: { t: 85 }, legend: { y: -0.08 },
  };
  const view = render(<PlotlyChart text={JSON.stringify({ data: [{ y: [1, 2] }], layout })} title="Yield" />);
  await view.findByRole('figure', { name: 'Yield' });
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  expect((plotly.react.mock.calls[0] as unknown[])[2]).toEqual(layout);
  expect((plotly.react.mock.calls[0] as unknown[])[3]).toMatchObject({ responsive: true });
});

it('lets a chart finish its active drag before purging it on unmount', async () => {
  plotly.purge.mockClear();
  const view = render(<PlotlyChart text='{"data":[{"y":[1,2]}]}' title="Line" />);
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  const chart = view.getByRole('figure').querySelector('.plotly-chart');
  assert.ok(chart);
  fireEvent.mouseDown(chart);
  view.unmount();
  expect(plotly.purge).not.toHaveBeenCalled();
  fireEvent.mouseMove(document);
  fireEvent.mouseUp(document);
  expect(plotly.purge).not.toHaveBeenCalled();
  await waitFor(() => expect(plotly.purge).toHaveBeenCalledWith(chart));
});

it('keeps a replacement chart separate from the chart finishing a touch drag', async () => {
  plotly.purge.mockClear();
  const view = render(<PlotlyChart text='{"data":[{"y":[1,2]}]}' title="Line" />);
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  const oldChart = view.getByRole('figure').querySelector('.plotly-chart');
  assert.ok(oldChart);
  fireEvent.touchStart(oldChart);
  view.rerender(<PlotlyChart text='{"data":[{"y":[3,4]}]}' title="Line" />);
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(2));
  const replacement = view.getByRole('figure').querySelector('.plotly-chart');
  expect(replacement).not.toBe(oldChart);
  expect(plotly.purge).not.toHaveBeenCalled();
  fireEvent.touchEnd(document);
  await waitFor(() => expect(plotly.purge).toHaveBeenCalledWith(oldChart));
  expect(plotly.purge).toHaveBeenCalledTimes(1);
  expect(plotly.purge.mock.calls[0]?.[0]).toBe(oldChart);
});

it('purges a draw that settles after its chart unmounts', async () => {
  const pending = Promise.withResolvers<undefined>();
  plotly.react.mockImplementationOnce(() => pending.promise);
  plotly.purge.mockClear();
  const view = render(<PlotlyChart text='{"data":[{"y":[1,2]}]}' title="Line" />);
  await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1));
  const chart = view.getByRole('figure').querySelector('.plotly-chart');
  view.unmount();
  expect(plotly.purge).not.toHaveBeenCalled();
  pending.resolve(undefined);
  await waitFor(() => expect(plotly.purge.mock.calls[0]?.[0]).toBe(chart));
});
