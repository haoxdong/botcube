import { createElement } from "react";

/**
 * The plotly.js a chart draws with: plotly's own prebuilt bundle of every trace type, so a markets agent's
 * candlestick, OHLC or waterfall draws as its line charts do. The bundler copies the file as an asset and never parses
 * or minifies it (4.8 MB, which ran Next's build out of memory), and a script tag loads it the first time a chart shows.
 */

/** As pdfjs-dist's worker is found: a URL the bundler emits for the package's file. */
const plotlyUrl = () => new URL('plotly.js-dist-min/plotly.min.js', import.meta.url).toString();

/**
 * A prefetch hint for plotly.js, so the first chart a reply shows draws without waiting ~2 s for 1.4 MB. React hoists
 * it into the head, and the browser fetches a prefetch at its lowest priority once the page has loaded. It runs none
 * of plotly's code.
 */
export const PlotlyPrefetch = () => createElement("link", { rel: "prefetch", as: "script", href: plotlyUrl() });

export default function loadPlotly(): Promise<unknown> {
  const page = window as Window & { Plotly?: unknown };
  if (page.Plotly !== undefined) return Promise.resolve(page.Plotly);
  const url = plotlyUrl();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () =>
      page.Plotly === undefined ? reject(new Error(`plotly.js loaded from ${url} without defining Plotly`)) : resolve(page.Plotly);
    script.onerror = () => {
      script.remove();
      reject(new Error(`plotly.js could not load from ${url}`));
    };
    document.head.append(script);
  });
}
