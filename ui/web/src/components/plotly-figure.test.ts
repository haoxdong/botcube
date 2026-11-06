import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { fittedLayout, headingOf, isFigureName, notesUnder, parseFigure } from './plotly-figure';

// Written by plotly 7.1.0's `fig.write_json`, the harness image's version.
const CPI = readFileSync(resolve(__dirname, '../../test/cpi.plotly.json'), 'utf8');

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

it('keeps the figure’s own look, its template included, and fits the layout to the box', () => {
  const template = { layout: { colorway: ['#0090ff'], font: { size: 13 } } };
  const layout = fittedLayout(
    { ...parseFigure(CPI).layout, template, yaxis2: { gridcolor: 'red' }, height: 900, margin: { r: 220 }, legend: { x: 1.02, title: { text: 'Series' } } },
    640,
  );
  expect(layout).not.toHaveProperty('height');
  expect(layout).not.toHaveProperty('title');
  expect(layout).toMatchObject({
    template,
    yaxis2: { gridcolor: 'red' },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    legend: { orientation: 'h', x: 0, y: 1, yanchor: 'bottom', title: { text: 'Series' } },
    margin: { l: 4, r: 8, t: 8, b: 4 },
    autosize: true,
  });
  expect(layout).not.toHaveProperty('xaxis');
});

it('gives the title and its source subtitle as plain text for the page to wrap', () => {
  expect(headingOf({ title: { text: 'US 10-year <b>Treasury</b> yield<br>since 2020', subtitle: { text: 'Source: FRED' } } }))
    .toEqual({ title: 'US 10-year Treasury yield\nsince 2020', subtitle: 'Source: FRED' });
  expect(headingOf({ title: 'Oil' })).toEqual({ title: 'Oil', subtitle: '' });
  expect(headingOf({})).toEqual({ title: '', subtitle: '' });
});

it('gives a phone plotly’s own level, fewer x ticks over the agent’s fixed monthly ones', () => {
  // The CPI chart a production Turn made: a tick every month labelled "%b %Y", six labels run together at 290px.
  const layout = fittedLayout({ xaxis: { title: { text: 'Month' }, dtick: 'M1', tick0: '2026-01-01', tickformat: '%b %Y', tickangle: -45 } }, 290);
  expect(layout.xaxis).toEqual({
    title: { text: 'Month' },
    tickmode: 'auto',
    tickangle: 0,
    nticks: 3,
    tickformatstops: [{ dtickrange: ['M1', 'M12'], value: "%b '%y" }, { dtickrange: ['M12', null], value: '%Y' }],
  });
  // As many ticks as the box has room for, between two and four.
  expect([260, 330, 400, 479].map((width) => fittedLayout({}, width).xaxis)).toMatchObject([{ nticks: 2 }, { nticks: 4 }, { nticks: 4 }, { nticks: 4 }]);
  // A numeric format and the agent's own labels stay; a desktop keeps the agent's ticks.
  expect(fittedLayout({ xaxis: { tickformat: '.1f', tickmode: 'array', tickvals: [1, 2], ticktext: ['a', 'b'] } }, 290).xaxis)
    .toMatchObject({ tickformat: '.1f', tickmode: 'array', tickvals: [1, 2], ticktext: ['a', 'b'], nticks: 3 });
  expect(fittedLayout({ xaxis: { dtick: 'M1', tickformat: '%b %Y' } }, 640).xaxis).toMatchObject({ dtick: 'M1', tickformat: '%b %Y' });
});

it('takes the notes under the plot out of plotly’s layout, for a caption under the chart', () => {
  const figure = {
    annotations: [
      { text: 'Source: user-provided <b>OHLC</b> values;<br>dates as supplied', xref: 'paper', yref: 'paper', x: 0, y: -0.25, showarrow: false },
      { text: 'peak', xref: 'x', yref: 'y', x: 3, y: 74 },
    ],
  };
  expect(notesUnder(figure)).toEqual(['Source: user-provided OHLC values;\ndates as supplied']);
  const layout = fittedLayout(figure, 290);
  expect(layout.annotations).toEqual([{ text: 'peak', xref: 'x', yref: 'y', x: 3, y: 74 }]);
  expect(layout.margin).toEqual({ l: 4, r: 8, t: 8, b: 4, pad: 0 });
  expect(notesUnder({})).toEqual([]);
});

it('knows a figure by its name', () => {
  expect(['cpi.plotly.json', 'CPI.Plotly.JSON', 'cpi.json', 'plotly.json.png'].map(isFigureName)).toEqual([true, true, false, false]);
});
