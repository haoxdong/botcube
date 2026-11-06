'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { notesUnder, parseFigure, themedLayout, type ChartPalette, type Figure } from './plotly-figure';

/** The slice of plotly.js a chart uses, from its prebuilt bundle of every trace type. */
interface Plotly {
  react(element: HTMLElement, data: unknown[], layout: unknown, config: unknown): Promise<unknown>;
  purge(element: HTMLElement): void;
  Plots: { resize(element: HTMLElement): Promise<unknown> };
  PlotSchema: { get(): { traces: Record<string, unknown> } };
}

/** plotly.js loads only once a chart shows, so the chat bundle does not carry it. */
let plotly: Promise<Plotly> | undefined;
const loadPlotly = () => {
  plotly ??= import('./plotly-bundle').then(async (module) => (await module.default()) as Plotly);
  // A failed load is forgotten, so the next chart tries again.
  void plotly.catch(() => (plotly = undefined));
  return plotly;
};

const CONFIG = {
  responsive: true,
  // No toolbar over the chart: hover, drag to zoom and a double click or tap to reset are the controls.
  displayModeBar: false,
  displaylogo: false,
  showLink: false,
  showSendToCloud: false,
  scrollZoom: false,
};

function palette(): ChartPalette {
  const root = getComputedStyle(document.documentElement);
  const read = (name: string) => {
    const value = root.getPropertyValue(`--color-${name}`).trim();
    if (value === '') throw new Error(`tokens.css defines no --color-${name} for charts`);
    return value;
  };
  return {
    text: read('text'),
    muted: read('text-muted'),
    line: read('line'),
    white: read('white'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/**
 * Draws `figure` into `element` with plotly.js in the app's look. A trace type plotly.js lacks fails loud, by name,
 * rather than leaving a blank plot.
 */
async function draw(element: HTMLElement, figure: Figure): Promise<Plotly> {
  const library = await loadPlotly();
  const known = library.PlotSchema.get().traces;
  const missing = figure.data
    .map((trace) => (typeof trace.type === 'string' ? trace.type : 'scatter'))
    .filter((type) => !Object.hasOwn(known, type));
  if (missing.length > 0) throw new Error(`plotly.js has no ${[...new Set(missing)].map((type) => `"${type}"`).join(', ')} chart type`);
  await library.react(element, figure.data, themedLayout(figure.layout, palette(), element.clientWidth), CONFIG);
  return library;
}

/**
 * A live Plotly chart from a `.plotly.json` file's text: it hovers, zooms and pans in place, across its box's
 * width, with the notes the agent put under the plot as a caption under it. The text is parsed and checked as data
 * (`parseFigure`); nothing the agent wrote runs. A chart that cannot draw shows the one-line reason and the file's
 * text as code in its place.
 */
export function PlotlyChart({ text, title }: { text: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const notes = useMemo(() => {
    try {
      return notesUnder(parseFigure(text).layout);
    } catch {
      return [];
    }
  }, [text]);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const gone = new AbortController();
    let drawn: Plotly | undefined;
    // plotly's `responsive` follows only the window; the box also changes width as the reply lays out, so the chart
    // redraws at the box's width whenever it does, and never runs past the bubble.
    const resized = new ResizeObserver(() => {
      if (drawn !== undefined) void drawn.Plots.resize(element);
    });
    setFailure(null);
    void (async () => {
      drawn = await draw(element, parseFigure(text));
      if (gone.signal.aborted) drawn.purge(element);
      else resized.observe(element);
    })().catch((cause: unknown) => {
      if (!gone.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      gone.abort();
      resized.disconnect();
      drawn?.purge(element);
    };
  }, [text]);
  if (failure !== null)
    return (
      <span className="plotly-chart-failed">
        <span role="alert">{`${title} could not draw: ${failure}`}</span>
        <pre><code>{text.length > 4000 ? `${text.slice(0, 4000)}…` : text}</code></pre>
      </span>
    );
  return (
    <div className="plotly-chart-frame" role="figure" aria-label={title}>
      <div ref={box} className="plotly-chart" />
      {notes.map((note, index) => <p key={index} className="plotly-chart-note">{note}</p>)}
    </div>
  );
}
