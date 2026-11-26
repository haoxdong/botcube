'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { parseFigure, type Figure } from './plotly-figure';
import { AlertLine } from '../app/alert-line';

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
    if (state === 'retiring') {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        retire();
      };
      port2.postMessage(null);
      port2.close();
    } else if (state !== 'retired') state = 'idle';
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

/** The size a scaled chart draws at: the figure's own width and height, else `drawWidth` and Plotly's default height. */
function drawnSize(text: string, drawWidth: number): CSSProperties | undefined {
  let layout: Figure['layout'];
  try {
    layout = parseFigure(text).layout;
  } catch {
    return undefined;
  }
  return {
    '--chart-width': typeof layout.width === 'number' ? layout.width : drawWidth,
    '--chart-height': typeof layout.height === 'number' ? layout.height : PLOTLY_HEIGHT,
  } as CSSProperties;
}

/**
 * A Plotly figure as a live chart. With `drawWidth`, Plotly lays the figure out at that width (or the width the figure
 * names) and its own height, and CSS scales it down to the frame's width, as an image would be; plotly.js maps hover
 * and drag through the CSS scale itself. Without it, Plotly lays it out at the frame's own size.
 */
export function PlotlyChart({ text, title, drawWidth }: { text: string; title: string; drawWidth?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const size = useMemo(() => (drawWidth === undefined ? undefined : drawnSize(text, drawWidth)), [text, drawWidth]);
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
        <AlertLine>{`${title} could not draw: ${failure}`}</AlertLine>
        <pre><code>{text.length > 4000 ? `${text.slice(0, 4000)}…` : text}</code></pre>
      </span>
    );
  return (
    <div className="plotly-chart-frame" role="figure" aria-label={title} data-scaled={size === undefined ? undefined : ''} style={size}>
      <div ref={box} style={{ display: 'contents' }} />
    </div>
  );
}
