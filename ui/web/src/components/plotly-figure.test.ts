import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isFigureName, parseFigure } from './plotly-figure';

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

it('passes the figure layout through unchanged, including images, annotations and shapes', () => {
  const layout = {
    title: { text: 'Short interest', subtitle: { text: 'Source' } },
    legend: { y: -0.08 }, margin: { t: 85 }, width: 800, height: 850,
    annotations: [{ text: 'Source', y: -0.16, yref: 'paper' }],
    images: [{ source: 'https://example.com/image.png' }],
    shapes: [{ type: 'line', y0: 1, y1: 1 }],
  };
  expect(parseFigure(JSON.stringify({ data: [], layout })).layout).toEqual(layout);
});

it('knows a figure by its name', () => {
  expect(['cpi.plotly.json', 'CPI.Plotly.JSON', 'cpi.json', 'plotly.json.png'].map(isFigureName)).toEqual([true, true, false, false]);
});
