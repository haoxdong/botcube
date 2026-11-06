import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isFigureName, notesUnder, parseFigure, themedLayout } from './plotly-figure';

// Written by plotly 7.1.0's `fig.write_json`, the harness image's version.
const CPI = readFileSync(resolve(__dirname, '../../test/cpi.plotly.json'), 'utf8');

const PALETTE = { text: '#202020', muted: '#646464', line: '#e0e0e0', white: '#fff', font: 'system-ui' };

it('reads a figure plotly.py wrote as its traces and layout only', () => {
  const figure = parseFigure(CPI);
  expect(figure.data.map((trace) => [trace.type, trace.name])).toEqual([['scatter', 'CPI YoY'], ['bar', 'MoM']]);
  expect(figure.layout.title).toEqual({ text: 'US CPI, 2026' });
  expect(Object.keys(parseFigure('{"data":[],"layout":{},"config":{"x":1},"frames":[]}'))).toEqual(['data', 'layout']);
});

it.each([
  ['{"data":[{"type":"scatter","hovertext":"<script>alert(1)</script>"}]}', 'the chart carries a script at data[0].hovertext'],
  ['{"data":[],"layout":{"annotations":[{"text":"<a href=\\"javascript:alert(1)\\">x</a>"}]}}', 'the chart carries a script at layout.annotations[0].text'],
  ['{"data":{}}', 'the chart has no list of traces under "data"'],
  ['{"data": [', 'the chart is not JSON'],
])('refuses %s', (text, reason) => {
  expect(() => parseFigure(text)).toThrow(reason);
});

it('keeps a layout image from the file itself and drops one from anywhere else', () => {
  const { layout } = parseFigure(JSON.stringify({
    data: [],
    layout: { images: [{ source: 'https://tracker.test/pixel.png' }, { source: 'data:image/png;base64,AAAA' }, { source: 7 }] },
  }));
  expect(layout.images).toEqual([{ source: 'data:image/png;base64,AAAA' }]);
});

it('draws the layout in the app’s look over the agent’s, keeping the agent’s trace colours', () => {
  const layout = themedLayout(
    { ...parseFigure(CPI).layout, yaxis2: { gridcolor: 'red', title: { text: 'bp' } }, height: 900, margin: { r: 220 }, legend: { x: 1.02, title: { text: 'Series' } } },
    PALETTE,
    640,
  );
  expect(layout).not.toHaveProperty('template');
  expect(layout).not.toHaveProperty('height');
  expect(layout).toMatchObject({
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    // plotly.py's template colorway, as the agent's traces would have drawn.
    colorway: ['#636efa', '#EF553B', '#00cc96', '#ab63fa', '#FFA15A', '#19d3f3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52'],
    font: { family: 'system-ui', color: '#202020' },
    title: { text: 'US CPI, 2026', x: 0, xanchor: 'left', font: { family: 'system-ui', color: '#202020' } },
    xaxis: { gridcolor: '#e0e0e0', linecolor: '#e0e0e0', automargin: true, tickfont: { family: 'system-ui', color: '#646464' } },
    yaxis2: { gridcolor: '#e0e0e0', title: { text: 'bp', font: { color: '#202020' } } },
    legend: { orientation: 'h', x: 0, y: 1, yanchor: 'bottom', title: { text: 'Series' } },
    margin: { l: 4, r: 8, t: 40, b: 4 },
    autosize: true,
  });
  expect(layout.xaxis).not.toHaveProperty('nticks');
});

it('gives a phone plotly’s own level, fewer x ticks over the agent’s fixed monthly ones', () => {
  // The CPI chart a production Turn made: a tick every month labelled "%b %Y", six labels run together at 290px.
  const layout = themedLayout({ xaxis: { title: { text: 'Month' }, dtick: 'M1', tick0: '2026-01-01', tickformat: '%b %Y', tickangle: -45 } }, PALETTE, 290);
  expect(layout.xaxis).toEqual({
    title: { text: 'Month', font: { family: 'system-ui', color: '#202020' } },
    tickmode: 'auto',
    tickangle: 0,
    nticks: 4,
    gridcolor: '#e0e0e0',
    linecolor: '#e0e0e0',
    zerolinecolor: '#e0e0e0',
    automargin: true,
    tickfont: { family: 'system-ui', color: '#646464' },
  });
  // A numeric format and the agent's own labels stay; a desktop keeps the agent's ticks.
  expect(themedLayout({ xaxis: { tickformat: '.1f', tickmode: 'array', tickvals: [1, 2], ticktext: ['a', 'b'] } }, PALETTE, 290).xaxis)
    .toMatchObject({ tickformat: '.1f', tickmode: 'array', tickvals: [1, 2], ticktext: ['a', 'b'], nticks: 4 });
  expect(themedLayout({ xaxis: { dtick: 'M1', tickformat: '%b %Y' } }, PALETTE, 640).xaxis).toMatchObject({ dtick: 'M1', tickformat: '%b %Y' });
});

it('takes the notes under the plot out of plotly’s layout, for a caption under the chart', () => {
  const figure = {
    annotations: [
      { text: 'Source: user-provided <b>OHLC</b> values;<br>dates as supplied', xref: 'paper', yref: 'paper', x: 0, y: -0.25, showarrow: false },
      { text: 'peak', xref: 'x', yref: 'y', x: 3, y: 74 },
    ],
  };
  expect(notesUnder(figure)).toEqual(['Source: user-provided OHLC values;\ndates as supplied']);
  const layout = themedLayout(figure, PALETTE, 290);
  expect(layout.annotations).toEqual([{ text: 'peak', xref: 'x', yref: 'y', x: 3, y: 74 }]);
  expect(layout.margin).toEqual({ l: 4, r: 8, t: 8, b: 4, pad: 0 });
  expect(notesUnder({})).toEqual([]);
});

it('knows a figure by its name', () => {
  expect(['cpi.plotly.json', 'CPI.Plotly.JSON', 'cpi.json', 'plotly.json.png'].map(isFigureName)).toEqual([true, true, false, false]);
});
