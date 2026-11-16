'use client';

import { useEffect, useRef, useState } from 'react';
import { parseFigure, type Figure } from './plotly-figure';

/** The slice of plotly.js a chart uses, from its prebuilt bundle of every trace type. */
interface Plotly {
  react(element: HTMLElement, data: unknown[], layout: unknown, config: unknown): Promise<unknown>;
  purge(element: HTMLElement): void;
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

async function draw(element: HTMLElement, figure: Figure): Promise<Plotly> {
  const library = await loadPlotly();
  const known = library.PlotSchema.get().traces;
  const missing = figure.data
    .map((trace) => (typeof trace.type === 'string' ? trace.type : 'scatter'))
    .filter((type) => !Object.hasOwn(known, type));
  if (missing.length > 0) throw new Error(`plotly.js has no ${[...new Set(missing)].map((type) => `"${type}"`).join(', ')} chart type`);
  await library.react(element, figure.data, figure.layout, CONFIG);
  return library;
}

function afterChartDrag(element: HTMLElement, purge: () => void): () => void {
  let state: 'idle' | 'dragging' | 'retiring' | 'retired' = 'idle';
  const listeners = new AbortController();
  const retire = () => {
    if (state === 'retired') return;
    state = 'retired';
    listeners.abort();
    purge();
  };
  const start = () => { state = 'dragging'; };
  const end = () => {
    // Plotly's document release handler must finish before purge deletes its layout.
    if (state === 'retiring') setTimeout(retire, 0);
    else if (state !== 'retired') state = 'idle';
  };
  const options = { capture: true, signal: listeners.signal };
  element.addEventListener('mousedown', start, options);
  element.addEventListener('touchstart', start, options);
  document.addEventListener('mouseup', end, options);
  document.addEventListener('touchend', end, options);
  return () => {
    if (state === 'dragging') state = 'retiring';
    else if (state === 'idle') retire();
  };
}

/** Plotly's own height for a figure that names none. */
const PLOTLY_HEIGHT = 450;

/**
 * Draws the chart at `drawWidth` (or the width the figure names) and its own height, then scales it down to the
 * frame's width, as an image would be; plotly.js maps hover and drag through the CSS scale itself. The frame takes
 * the scaled height, so the text after the chart sits right under it.
 */
function scaleToFrame(element: HTMLElement, frame: HTMLElement, figure: Figure, drawWidth: number, signal: AbortSignal) {
  const width = typeof figure.layout.width === 'number' ? figure.layout.width : drawWidth;
  const height = typeof figure.layout.height === 'number' ? figure.layout.height : PLOTLY_HEIGHT;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  const fit = () => {
    const scale = frame.clientWidth / width;
    element.style.transform = `scale(${scale})`;
    frame.style.height = `${height * scale}px`;
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(frame);
  signal.addEventListener('abort', () => observer.disconnect());
}

/**
 * A Plotly figure as a live chart. With `drawWidth`, Plotly lays the figure out at that width and the chart is scaled
 * to fit its frame (scaleToFrame); without it, Plotly lays it out at the frame's own size.
 */
export function PlotlyChart({ text, title, drawWidth }: { text: string; title: string; drawWidth?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const host = box.current;
    if (host === null) return;
    const element = document.createElement('div');
    element.className = 'plotly-chart';
    host.append(element);
    const gone = new AbortController();
    let drawn: Plotly | undefined;
    const dispose = afterChartDrag(element, () => drawn?.purge(element));
    setFailure(null);
    const drawing = (async () => {
      const figure = parseFigure(text);
      if (drawWidth !== undefined && host.parentElement !== null)
        scaleToFrame(element, host.parentElement, figure, drawWidth, gone.signal);
      drawn = await draw(element, figure);
    })().catch((cause: unknown) => {
      if (!gone.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      gone.abort();
      element.remove();
      void drawing.then(dispose);
    };
  }, [text, drawWidth]);
  if (failure !== null)
    return (
      <span className="plotly-chart-failed">
        <span role="alert">{`${title} could not draw: ${failure}`}</span>
        <pre><code>{text.length > 4000 ? `${text.slice(0, 4000)}…` : text}</code></pre>
      </span>
    );
  return (
    <div className="plotly-chart-frame" role="figure" aria-label={title} data-scaled={drawWidth === undefined ? undefined : ''}>
      <div ref={box} style={{ display: 'contents' }} />
    </div>
  );
}
