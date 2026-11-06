/**
 * The plotly.js a chart draws with: plotly's own prebuilt bundle of every trace type, so a markets agent's
 * candlestick, OHLC or waterfall draws as its line charts do. The bundler copies the file as an asset and never parses
 * or minifies it (4.8 MB, which ran Next's build out of memory), and a script tag loads it the first time a chart shows.
 */

/** As pdfjs-dist's worker is found: a URL the bundler emits for the package's file. */
const plotlyUrl = () => new URL('plotly.js-dist-min/plotly.min.js', import.meta.url).toString();

/**
 * Asks the browser, once the page is idle, to fetch plotly.js at low priority, so the first chart a reply shows
 * draws without waiting ~2 s for 1.4 MB. One prefetch link per page; it runs none of plotly's code.
 */
export function prefetchPlotly(): () => void {
  const start = () => {
    if (document.head.querySelector('link[data-plotly-prefetch]') !== null) return;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'script';
    link.href = plotlyUrl();
    link.dataset.plotlyPrefetch = '';
    document.head.append(link);
  };
  if ('requestIdleCallback' in window) {
    const idle = window.requestIdleCallback(start, { timeout: 10_000 });
    return () => window.cancelIdleCallback(idle);
  }
  const timer = setTimeout(start, 3_000);
  return () => clearTimeout(timer);
}

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
