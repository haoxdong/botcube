import { INLINE } from "botcube-artifact-check/subset";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

import type { DeckFile } from "./artifact-slides";
import { layOut, slidesOf } from "./slide-layout";
import {
  color, dashOf, decorationOf, gradientPng, noForm, opacityOf, outlineOf, points, px, refuseEffects, shadowOf, sidesOf, turnOf, type Side,
} from "./slide-styles";

/**
 * A Slides deck as an editable PowerPoint, written in the browser from the files on screen. Each slide is laid out in a
 * hidden frame as its sandbox page lays it out, then each element of the slide format becomes PowerPoint's own
 * object: a painted `<div>` a shape, a heading or `<p>` a text box, a list bulleted text, a `<table>` a table, an
 * `<hr>` a line, an `<x-shape>` its shape, `<aside>` the speaker notes, and a gradient a small picture behind them.
 * Shadows, opacity, rotation, strike-through and dashed borders become PowerPoint's own; whatever has no PowerPoint
 * form fails the export, naming the slide and what failed, rather than go missing.
 */
export async function deckPptx(title: string, folder: string, files: readonly DeckFile[]): Promise<Blob> {
  const frame = layOut(slidesOf(folder, files));
  try {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.title = title;
    frame.document.querySelectorAll("body > section").forEach((section) => writeSlide(pptx, section, frame.window, section.id));
    const written = await pptx.write({ outputType: "arraybuffer" });
    if (!(written instanceof ArrayBuffer)) throw new Error("PptxGenJS wrote no file");
    return await oneParagraphProperties(written);
  } finally {
    frame.element.remove();
  }
}

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** A paragraph's properties after one of its runs: what PptxGenJS 4.0.1 adds for each run past the first. */
const LATER_PROPERTIES = /(<\/a:r>)<a:pPr\b[^>]*?(?:\/>|>.*?<\/a:pPr>)/g;

/**
 * PptxGenJS 4.0.1 writes a paragraph's `<a:pPr>` again before each of its runs once the text box sets an alignment or
 * line spacing; the schema allows one, first, and PowerPoint offers to repair the file. Each paragraph keeps its first.
 */
async function oneParagraphProperties(written: ArrayBuffer): Promise<Blob> {
  const zip = await JSZip.loadAsync(written);
  const slides = zip.file(/^ppt\/slides\/slide\d+\.xml$/);
  await Promise.all(slides.map(async (file) => zip.file(file.name, (await file.async("string")).replace(LATER_PROPERTIES, "$1"))));
  return zip.generateAsync({ type: "blob", mimeType: PPTX, compression: "DEFLATE" });
}

/** 1920 px across a 13.333 in slide is 144 px an inch. */
const inches = (value: number) => +(value / 144).toFixed(4);

type Box = { x: number; y: number; w: number; h: number };
/**
 * Where an element is drawn: its slide, the opacity it inherits from its ancestors, and the rotation, in degrees, about
 * `pivot`, the centre of its own box, that it and its ancestors add up to.
 */
type Context = {
  pptx: PptxGenJS; slide: PptxGenJS.Slide; window: Window; origin: DOMRect; id: string;
  alpha: number; turn: number; pivot: { x: number; y: number } | null;
};

function writeSlide(pptx: PptxGenJS, section: Element, window: Window, id: string) {
  const slide = pptx.addSlide();
  slide.hidden = section.hasAttribute("hidden");
  const style = window.getComputedStyle(section);
  refuseEffects(style, id);
  if (opacityOf(style) !== 1) throw noForm(id, "opacity on a <section>");
  if (!["", "none"].includes(style.transform)) throw noForm(id, "transform on a <section>");
  const fill = color(style.backgroundColor, id);
  const gradient = gradientPng(style.backgroundImage, { w: 1920, h: 1080 }, id);
  if (gradient !== null) slide.background = { data: gradient };
  else if (fill !== null) slide.background = { color: fill.color };
  mapChildren(section, { pptx, slide, window, origin: section.getBoundingClientRect(), id, alpha: 1, turn: 0, pivot: null });
  const notes = section.querySelector(":scope > aside")?.textContent.trim();
  if (notes) slide.addNotes(notes);
}

const TEXT_BLOCKS = new Set(["h1", "h2", "h3", "p"]);

function mapElement(element: Element, parent: Context) {
  const tag = element.tagName.toLowerCase();
  const style = parent.window.getComputedStyle(element);
  if (tag === "aside" || (style.display === "none" && tag !== "x-embed")) return;
  refuseEffects(style, parent.id);
  const { box, context } = place(element, style, parent);
  if (tag === "div") {
    paint(context, style, box);
    mapChildren(element, context);
  } else if (TEXT_BLOCKS.has(tag)) {
    paint(context, style, box);
    context.slide.addText(runs(element, context), textOptions(style, contentBox(box, style), context));
  } else if (tag === "ul" || tag === "ol") {
    mapList(element, tag, style, box, context);
  } else if (tag === "table") {
    mapTable(element, style, box, context);
  } else if (tag === "hr") {
    mapLine(style, box, context);
  } else if (tag === "x-shape") {
    mapShape(element, style, box, context);
  } else {
    throw noForm(context.id, `<${tag}>`);
  }
}

function mapChildren(element: Element, context: Context) {
  const loose = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (loose) throw noForm(context.id, `text straight in a <${element.tagName.toLowerCase()}>`);
  for (const child of Array.from(element.children)) mapElement(child, context);
}

function place(element: Element, style: CSSStyleDeclaration, parent: Context): { box: Box; context: Context } {
  const rect = element.getBoundingClientRect();
  const turn = parent.turn + turnOf(style.transform, parent.id);
  const alpha = parent.alpha * opacityOf(style);
  const x = rect.left - parent.origin.left;
  const y = rect.top - parent.origin.top;
  if (turn === 0) return { box: { x, y, w: rect.width, h: rect.height }, context: { ...parent, alpha, turn, pivot: null } };
  const w = element.clientWidth + px(style.borderLeftWidth) + px(style.borderRightWidth);
  const h = element.clientHeight + px(style.borderTopWidth) + px(style.borderBottomWidth);
  const pivot = { x: x + rect.width / 2, y: y + rect.height / 2 };
  return { box: { x: pivot.x - w / 2, y: pivot.y - h / 2, w, h }, context: { ...parent, alpha, turn, pivot } };
}

function boxAt(box: Box) {
  return { x: inches(box.x), y: inches(box.y), w: inches(box.w), h: inches(box.h) };
}

function at(box: Box, { turn, pivot }: Context) {
  if (turn === 0 || pivot === null) return boxAt(box);
  const radians = (turn * Math.PI) / 180;
  const dx = box.x + box.w / 2 - pivot.x;
  const dy = box.y + box.h / 2 - pivot.y;
  const x = pivot.x + dx * Math.cos(radians) - dy * Math.sin(radians);
  const y = pivot.y + dx * Math.sin(radians) + dy * Math.cos(radians);
  return { ...boxAt({ x: x - box.w / 2, y: y - box.h / 2, w: box.w, h: box.h }), rotate: +turn.toFixed(2) };
}

function contentBox(box: Box, style: CSSStyleDeclaration): Box {
  const inset = (side: "Top" | "Right" | "Bottom" | "Left") => px(style[`padding${side}`]) + px(style[`border${side}Width`]);
  return { x: box.x + inset("Left"), y: box.y + inset("Top"), w: box.w - inset("Left") - inset("Right"), h: box.h - inset("Top") - inset("Bottom") };
}

const faceOf = (style: CSSStyleDeclaration) => (style.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
const ALIGN = { start: "left", left: "left", center: "center", right: "right", end: "right", justify: "justify" } as const;
const alignOf = (style: CSSStyleDeclaration) => Object.hasOwn(ALIGN, style.textAlign) ? ALIGN[style.textAlign as keyof typeof ALIGN] : "left";
const bold = (style: CSSStyleDeclaration) => Number(style.fontWeight) >= 600 || style.fontWeight === "bold";

function shapeOf({ pptx, id }: Context, radius: number, gradient: string | null, geometry?: PptxGenJS.SHAPE_NAME) {
  const { rect, roundRect } = pptx.ShapeType;
  const shape = geometry !== undefined && geometry !== rect ? geometry : radius > 0 ? roundRect : rect;
  if (gradient !== null && shape !== rect && shape !== roundRect) throw noForm(id, `a gradient on <x-shape kind="${geometry}">`);
  return shape;
}

function paint(context: Context, style: CSSStyleDeclaration, box: Box, geometry?: PptxGenJS.SHAPE_NAME) {
  const { pptx, slide, alpha, id } = context;
  const fill = color(style.backgroundColor, id, alpha);
  const gradient = gradientPng(style.backgroundImage, box, id);
  const sides = sidesOf(style, alpha, id);
  const uniform = outlineOf(sides);
  const shadow = shadowOf(style, "box-shadow", alpha, id);
  if (shadow !== undefined && fill === null) throw noForm(id, "box-shadow on a box with no background colour");
  const radius = px(style.borderTopLeftRadius);
  const shape = shapeOf(context, radius, gradient, geometry);
  const outline = uniform ?? { type: "none" as const };
  const corners = shape === pptx.ShapeType.roundRect && radius > 0 ? { rectRadius: Math.min(0.5, radius / Math.min(box.w, box.h)) } : {};
  const filled = fill ?? { type: "none" as const };
  const line = gradient === null ? outline : { type: "none" as const };
  if (fill !== null || geometry !== undefined || (uniform !== null && gradient === null)) {
    slide.addShape(shape, { ...at(box, context), ...corners, ...(shadow ? { shadow } : {}), fill: filled, line });
  }
  if (gradient !== null) {
    slide.addImage({ data: gradient, ...at(box, context), transparency: Math.round((1 - alpha) * 100) });
    if (uniform !== null) slide.addShape(shape, { ...at(box, context), ...corners, fill: { type: "none" }, line: outline });
  }
  if (uniform === null) sides.forEach((side) => paintSide(context, box, side));
}

function paintSide(context: Context, box: Box, { side, width, line }: Side) {
  const { pptx, slide } = context;
  const edge = {
    Top: { ...box, h: width }, Bottom: { ...box, y: box.y + box.h - width, h: width },
    Left: { ...box, w: width }, Right: { ...box, x: box.x + box.w - width, w: width },
  }[side];
  if (line.dashType === "solid") {
    slide.addShape(pptx.ShapeType.rect, { ...at(edge, context), fill: { color: line.color, transparency: line.transparency }, line: { type: "none" } });
    return;
  }
  const middle = side === "Top" || side === "Bottom" ? { ...edge, y: edge.y + width / 2, h: 0 } : { ...edge, x: edge.x + width / 2, w: 0 };
  slide.addShape(pptx.ShapeType.line, { ...at(middle, context), line });
}

function runs(element: Element, context: Context): PptxGenJS.TextProps[] {
  const out: PptxGenJS.TextProps[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE && node.parentElement !== null) out.push(run(node, element, context));
    else if (node.nodeName === "BR") {
      const last = out.at(-1);
      if (last !== undefined) last.options = { ...last.options, breakLine: true };
    } else if (node.nodeType === Node.ELEMENT_NODE && !INLINE.includes(node.nodeName.toLowerCase())) {
      throw noForm(context.id, `<${node.nodeName.toLowerCase()}> inside <${element.tagName.toLowerCase()}>`);
    } else node.childNodes.forEach(walk);
  };
  element.childNodes.forEach(walk);
  const [head, tail] = [out[0], out.at(-1)];
  if (head !== undefined) head.text = (head.text ?? "").replace(/^ /, "");
  if (tail !== undefined) tail.text = (tail.text ?? "").replace(/ $/, "");
  return out.filter(({ text, options }) => text !== "" || options?.breakLine);
}

function run(node: Node, block: Element, context: Context): PptxGenJS.TextProps {
  const parent = node.parentElement ?? block;
  const style = context.window.getComputedStyle(parent);
  const text = (node.textContent ?? "").replace(/\s+/g, " ");
  const link = parent.closest("a")?.getAttribute("href");
  const paint = color(style.color, context.id, context.alpha);
  return {
    text: style.textTransform === "uppercase" ? text.toUpperCase() : text,
    options: {
      bold: bold(style), italic: style.fontStyle === "italic",
      ...(paint ? { color: paint.color } : {}),
      ...(paint && paint.transparency > 0 ? { transparency: paint.transparency } : {}),
      ...decorationOf(parent, block, context.window, context.id),
      ...(link ? { hyperlink: { url: link } } : {}),
    },
  };
}

function textOptions(style: CSSStyleDeclaration, box: Box, context: Context): PptxGenJS.TextPropsOptions {
  const size = px(style.fontSize);
  const lineHeight = style.lineHeight === "normal" ? 1.2 * size : px(style.lineHeight);
  const shadow = shadowOf(style, "text-shadow", context.alpha, context.id);
  const paint = color(style.color, context.id);
  return {
    // A browser wraps a line a hair later than PowerPoint does: 4 px more keeps each line whole.
    ...at({ ...box, w: box.w + 4 }, context),
    fontFace: faceOf(style), fontSize: points(size), ...(paint ? { color: paint.color } : {}),
    bold: bold(style), italic: style.fontStyle === "italic", align: alignOf(style),
    valign: "top", margin: 0, inset: 0, wrap: true, fit: "none", lineSpacing: points(lineHeight),
    ...(style.letterSpacing === "normal" ? {} : { charSpacing: points(px(style.letterSpacing)) }),
    paraSpaceBefore: 0, paraSpaceAfter: 0, ...(shadow ? { shadow } : {}),
  };
}

function mapList(element: Element, tag: "ul" | "ol", style: CSSStyleDeclaration, box: Box, context: Context) {
  const items = Array.from(element.children).filter((child) => child.tagName === "LI");
  const [first] = items;
  const indent = first ? first.getBoundingClientRect().left - element.getBoundingClientRect().left : 0;
  const bullet = tag === "ol" ? { type: "number" as const, indent: points(indent) } : { indent: points(indent) };
  const paragraphs = items.flatMap((item, index) => {
    const parts = runs(item, context);
    // PptxGenJS starts a new paragraph at a run with a bullet, so only an item's first run carries it.
    return parts.map((part, at) => ({
      text: part.text ?? "",
      options: { ...part.options, ...(at === 0 ? { bullet } : {}), ...(at === parts.length - 1 && index < items.length - 1 ? { breakLine: true } : {}) },
    }));
  });
  const content = contentBox(box, style);
  context.slide.addText(paragraphs, textOptions(style, { ...content, x: box.x, w: box.w }, context));
}

function mapTable(element: Element, style: CSSStyleDeclaration, box: Box, context: Context) {
  if (context.turn !== 0) throw noForm(context.id, "a rotated <table>");
  if (context.alpha !== 1) throw noForm(context.id, "opacity on a <table>");
  if (shadowOf(style, "text-shadow", context.alpha, context.id) !== undefined) throw noForm(context.id, "text-shadow in a <table>");
  const rows = Array.from(element.querySelectorAll("tr"));
  const data = rows.map((row) => {
    const rowFill = color(context.window.getComputedStyle(row).backgroundColor, context.id);
    return Array.from(row.children).map((cell) => tableCell(cell, rowFill, context));
  });
  context.slide.addTable(data, {
    ...boxAt(box),
    colW: Array.from(rows[0]?.children ?? []).map((cell) => inches(cell.getBoundingClientRect().width)),
    rowH: rows.map((row) => inches(row.getBoundingClientRect().height)),
  });
}

function tableCell(cell: Element, rowFill: ReturnType<typeof color>, context: Context): PptxGenJS.TableCell {
  const style = context.window.getComputedStyle(cell);
  const fill = color(style.backgroundColor, context.id) ?? rowFill;
  const edge = (side: "Top" | "Right" | "Bottom" | "Left"): PptxGenJS.BorderProps => {
    const width = px(style[`border${side}Width`]);
    if (width === 0) return { type: "none" };
    const paint = color(style[`border${side}Color`], context.id);
    return paint === null ? { type: "none" } : { type: "solid", pt: points(width), color: paint.color };
  };
  const pad = (side: string) => points(px(side));
  const paint = color(style.color, context.id);
  return {
    text: runs(cell, context),
    options: {
      fontFace: faceOf(style), fontSize: points(px(style.fontSize)), ...(paint ? { color: paint.color } : {}), bold: bold(style),
      valign: "middle", align: alignOf(style), ...(fill === null ? {} : { fill: { color: fill.color } }),
      margin: [pad(style.paddingTop), pad(style.paddingRight), pad(style.paddingBottom), pad(style.paddingLeft)],
      border: [edge("Top"), edge("Right"), edge("Bottom"), edge("Left")],
    },
  };
}

function mapLine(style: CSSStyleDeclaration, box: Box, context: Context) {
  const paint = color(style.borderTopColor, context.id, context.alpha) ?? color(style.color, context.id, context.alpha);
  if (paint === null) return;
  context.slide.addShape(context.pptx.ShapeType.line, {
    ...at({ ...box, h: 0 }, context),
    line: { ...paint, width: points(px(style.borderTopWidth) || 1), dashType: dashOf(style.borderTopStyle, context.id) },
  });
}

function mapShape(element: Element, style: CSSStyleDeclaration, box: Box, context: Context) {
  const { ShapeType } = context.pptx;
  const kinds: Record<string, PptxGenJS.SHAPE_NAME> = {
    rect: ShapeType.rect, rounded: ShapeType.roundRect, ellipse: ShapeType.ellipse, diamond: ShapeType.diamond,
    "arrow-right": ShapeType.rightArrow, "arrow-left": ShapeType.leftArrow, "arrow-up": ShapeType.upArrow,
    "arrow-down": ShapeType.downArrow, line: ShapeType.line,
  };
  const kind = element.getAttribute("kind") ?? "rect";
  if (!Object.hasOwn(kinds, kind)) throw noForm(context.id, `<x-shape kind="${kind}">`);
  paint(context, style, box, kinds[kind]);
  const text = runs(element, context);
  if (text.length > 0) context.slide.addText(text, textOptions(style, contentBox(box, style), context));
}
