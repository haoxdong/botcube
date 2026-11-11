// html-to-docx's browser build, which carries no Node module; the Doc's Word Export imports this file on Download.
import htmlToDocx from "@turbodocx/html-to-docx/dist/html-to-docx.browser.esm.js";
// The npm package, by the path that no bundler or tool reads as Node's own `buffer`.
import { Buffer } from "buffer/";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The Word file of a Doc's HTML, as the Doc's viewer makes it. Images held as data: URIs are embedded in it. */
export async function wordOf(html: string, title: string): Promise<Blob> {
  const made = await withNode(() => htmlToDocx(checkboxesAsText(html), null, { title, table: { row: { cantSplit: true } }, font: "Inter" }));
  return made instanceof Blob ? made : new Blob([made], { type: DOCX });
}

/**
 * html-to-docx's browser build still names Node's `global`, and decodes images with Node's `Buffer`. Webpack gives each
 * module both of its own (Next's client build provides `Buffer`); under a bundler that gives neither (Vite, which
 * Storybook runs), the page lends them for this call alone and takes them back after.
 */
async function withNode<T>(run: () => Promise<T>): Promise<T> {
  const scope = globalThis as Record<string, unknown>;
  const lent = Object.entries({ global: globalThis, Buffer }).filter(([name]) => !(name in scope));
  for (const [name, value] of lent) scope[name] = value;
  try {
    return await run();
  } finally {
    for (const [name] of lent) delete scope[name];
  }
}

/**
 * Tiptap draws a task item as a checkbox beside a block, which html-to-docx drops with its text; Word gets the item's
 * text after a ballot box, checked or not.
 */
function checkboxesAsText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const item of parsed.querySelectorAll('li[data-type="taskItem"]')) {
    const box = item.getAttribute("data-checked") === "true" ? "☑ " : "☐ ";
    item.querySelector(":scope > label")?.remove();
    const body = item.querySelector(":scope > div");
    body?.replaceWith(...body.childNodes);
    const first = item.querySelector("p") ?? item;
    first.prepend(box);
  }
  return parsed.body.innerHTML;
}
