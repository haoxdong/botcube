import { ELEMENTS, PROPERTIES, SVG_ATTRIBUTES, SVG_ELEMENTS } from "botcube-artifact-check/subset";
import DOMPurify from "dompurify";

/**
 * A slide as its frame shows it: the section with only what the slide format allows, each `<x-embed>` emptied, and
 * the live pages those held, in order, for frames of their own.
 */
export type CleanSlide = { html: string; embeds: Embed[]; stripped: string[] };
/** A live page from a slide's `<x-embed>`, pinned where `style` puts it on the 1920×1080 canvas. */
export type Embed = { style: string; html: string };

const PROPERTY_NAMES = new Set(PROPERTIES.flatMap((row) => row.names));
const EMBED = /<x-embed\b([^>]*)>([\s\S]*?)<\/x-embed\s*>/gi;
const STYLE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The declarations of a style attribute the format allows; every other one is listed as stripped. */
function allowedStyle(file: string, tag: string, style: string, stripped: string[]): string {
  const kept: string[] = [];
  for (const declaration of style.split(";").map((part) => part.trim()).filter(Boolean)) {
    const at = declaration.indexOf(":");
    const property = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).trim();
    if (at > 0 && PROPERTY_NAMES.has(property) && !/url\s*\(|var\s*\(|expression\s*\(/i.test(value)) kept.push(`${property}:${value}`);
    else stripped.push(`${file}: <${tag}> ${declaration}`);
  }
  return kept.join(";");
}

/**
 * The safety net under the publish check (the checker refused anything outside the format already): DOMPurify keeps
 * only the format's elements, attributes and CSS properties, and lists all it strips. A partial slide, still being
 * written, comes through too: whatever is half-written is dropped or closed.
 */
export function sanitizeSlide(file: string, source: string): CleanSlide {
  const stripped: string[] = [];
  const embeds: Embed[] = [];
  const emptied = source.replace(EMBED, (_whole, attributes: string, page: string) => {
    const style = STYLE.exec(attributes);
    embeds.push({ style: allowedStyle(file, "x-embed", style?.[1] ?? style?.[2] ?? "", stripped), html: page });
    return `<x-embed${attributes}></x-embed>`;
  });
  const purify = DOMPurify(window);
  purify.addHook("uponSanitizeAttribute", (node, data) => {
    // Inside an svg chart, only the subset's svg attributes, as the checker holds them: no style there.
    const inChart = node.namespaceURI === SVG_NAMESPACE && node.nodeName.toLowerCase() !== "svg";
    if (inChart && !SVG_ATTRIBUTES.includes(data.attrName) && !/^(id|class|data-[\w-]+)$/.test(data.attrName)) data.keepAttr = false;
    else if (data.attrName === "style" && data.keepAttr) data.attrValue = allowedStyle(file, node.nodeName.toLowerCase(), data.attrValue, stripped);
  });
  const html = purify.sanitize(emptied, {
    ALLOWED_TAGS: [...Object.keys(ELEMENTS), ...SVG_ELEMENTS],
    ALLOWED_ATTR: ["style", "id", "class", ...new Set(Object.values(ELEMENTS).flat()), ...SVG_ATTRIBUTES],
    ALLOW_DATA_ATTR: true,
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^x-(shape|icon|connector|embed)$/,
      attributeNameCheck: /^(kind|name|x1|y1|x2|y2|head|head-start|head-end|route|from|style|data-[\w-]+)$/,
      allowCustomizedBuiltInElements: false,
    },
    // A slide has no navigation: a link shows as its text, and following it would only navigate the slide's frame.
    // Its href stays in the Source, and is not listed as stripped.
    FORBID_ATTR: ["href"],
    // An image is held in the slide as a data: URI, which DOMPurify keeps on an <img src>; no other URL is kept.
    ALLOWED_URI_REGEXP: /^#/,
    // DOMPurify holds every allowed attribute but its short URI-safe list to ALLOWED_URI_REGEXP: `kind="ellipse"`
    // or an svg path's `d` would fail it. Only `src` holds a URL here.
    ADD_URI_SAFE_ATTR: [...new Set(Object.values(ELEMENTS).flat()), ...SVG_ATTRIBUTES].filter((name) => name !== "src"),
  });
  for (const removed of purify.removed as Array<{ element?: Node; attribute?: Attr | null; from?: Node }>) {
    if (removed.attribute?.name === "href") continue;
    if (removed.attribute) stripped.push(`${file}: <${removed.from?.nodeName.toLowerCase()} ${removed.attribute.name}>`);
    else if (removed.element?.nodeType === Node.ELEMENT_NODE && !/^(body|html|head)$/i.test(removed.element.nodeName)) {
      stripped.push(`${file}: <${removed.element.nodeName.toLowerCase()}>`);
    }
  }
  return { html, embeds, stripped: [...new Set(stripped)] };
}
