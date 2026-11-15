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

export function PlotlyChart({ text, title }: { text: string; title: string }) {
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
      drawn = await draw(element, parseFigure(text));
    })().catch((cause: unknown) => {
      if (!gone.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      gone.abort();
      element.remove();
      void drawing.then(dispose);
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
      <div ref={box} style={{ display: 'contents' }} />
    </div>
  );
}
