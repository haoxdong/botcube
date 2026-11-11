import { orderOf, type DeckFile } from "./artifact-slides";
import { sanitizeSlide } from "./slide-sanitize";

/** The deck's slides as the export reads them: the ones deck.json lists, cleaned and laid out as the Viewer shows them. */

type Frame = { element: HTMLIFrameElement; document: Document; window: Window };

/**
 * The sandbox page's slide CSS (public/artifact-sandbox/slides/index.html), so the export matches what's shown. A table
 * rule is 15% of the frame's own ink (CanvasText), which draws the sandbox's 15% black.
 */
const SLIDE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { margin: 0; }
  section { position: relative; width: 1920px; height: 1080px; overflow: hidden; display: flex; flex-direction: column; font-family: sans-serif; }
  div { display: flex; flex-direction: column; min-width: 0; }
  h1 { font-size: 96px; font-weight: 600; line-height: 1.1; } h2 { font-size: 64px; font-weight: 600; line-height: 1.15; }
  h3 { font-size: 44px; font-weight: 600; line-height: 1.2; } p { font-size: 32px; line-height: 1.4; }
  ul, ol { padding-left: 1.2em; } aside, x-embed { display: none; }
  table { border-collapse: collapse; } th, td { padding: 0.35em 0.6em; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  th { font-weight: 600; } x-shape { display: block; } x-shape[kind="ellipse"] { border-radius: 50%; }`;
/** The slide frames' policy: a slide loads nothing. */
const SLIDE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The slides deck.json lists, in its order, each through the viewer's sanitizer. */
export function slidesOf(folder: string, files: readonly DeckFile[]): string[] {
  const index = files.find(({ path }) => path === `${folder}/project/deck.json`);
  if (index === undefined) throw new Error(`${folder} has no project/deck.json`);
  const order = orderOf(index.text);
  if (order === null) throw new Error("its deck.json does not parse as a deck");
  const texts = new Map(files.map(({ path, text }) => [path, text]));
  return [...new Set(order)].map((id) => {
    const text = texts.get(`${folder}/project/slides/${id}.html`);
    if (text === undefined) throw new Error(`deck.json lists slide ${id}, which has no file`);
    return sanitizeSlide(`slides/${id}.html`, text).html;
  });
}

/** The slides laid out at 1920×1080 in a frame of the app's origin that runs no scripts and loads nothing. */
export function layOut(sections: string[]): Frame {
  const element = document.createElement("iframe");
  element.setAttribute("sandbox", "allow-same-origin");
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;
  element.style.cssText = "position: fixed; left: -100000px; top: 0; width: 1920px; height: 1080px; border: 0;";
  document.body.append(element);
  const frameDocument = element.contentDocument;
  const frameWindow = element.contentWindow;
  if (frameDocument === null || frameWindow === null) throw new Error("the layout frame has no document");
  frameDocument.open();
  frameDocument.write(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SLIDE_POLICY}"><style>${SLIDE_CSS}</style></head><body>${sections.join("\n")}</body></html>`);
  frameDocument.close();
  return { element, document: frameDocument, window: frameWindow };
}
