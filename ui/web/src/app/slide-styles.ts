import type PptxGenJS from "pptxgenjs";

/** A slide element's computed CSS as PowerPoint's own values, or the failure that names what has no PowerPoint form. */

export const noForm = (id: string, what: string) => new Error(`slide ${id}: ${what} has no PowerPoint form yet`);

/** The effects that have no PowerPoint form, at the computed values that show nothing. */
const EFFECTS: Record<string, string> = { filter: "none", "backdrop-filter": "none", "mix-blend-mode": "normal" };

export function refuseEffects(style: CSSStyleDeclaration, id: string) {
  for (const [name, none] of Object.entries(EFFECTS)) {
    const value = style.getPropertyValue(name);
    if (value !== "" && value !== none) throw noForm(id, name);
  }
}

export const opacityOf = (style: CSSStyleDeclaration) => (style.opacity === "" ? 1 : Number(style.opacity));

/**
 * A computed transform's rotation in degrees. Browsers compute a transform as a `matrix()`; one that scales or skews
 * has no PowerPoint form.
 */
export function turnOf(transform: string, id: string): number {
  if (transform === "" || transform === "none") return 0;
  const matrix = /^matrix\(([^)]*)\)$/.exec(transform)?.[1];
  if (matrix === undefined) throw noForm(id, `transform: ${transform}`);
  const [a = 1, b = 0, c = 0, d = 1] = matrix.split(",").map(Number);
  if (Math.abs(a * c + b * d) > 0.001) throw noForm(id, "transform: skew");
  if (Math.abs(Math.hypot(a, b) - 1) > 0.001 || Math.abs(Math.hypot(c, d) - 1) > 0.001) throw noForm(id, "transform: scale");
  return (Math.atan2(b, a) * 180) / Math.PI;
}

export const px = (value: string) => parseFloat(value) || 0;
/** 1920 px across a 960 pt slide. */
export const points = (value: number) => +(value / 2).toFixed(1);
/**
 * A computed CSS colour, seen through `alpha`, as PowerPoint's hex and transparency; null when it paints nothing. The
 * browser computes a colour as `rgb()`/`rgba()` with 0–255 channels, or, from `color-mix()` and `color()`, as
 * `color(srgb …)` with 0–1 channels. Any other colour the slide format allows, such as `oklch()` or a `display-p3`
 * one, has no PowerPoint form yet.
 */
export function color(css: string, id: string, alpha = 1): { color: string; transparency: number } | null {
  const found = /rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/.exec(css);
  if (found === null) throw noForm(id, `the colour ${css}`);
  const scale = found[1] === undefined ? 255 : 1;
  const [r = "0", g = "0", b = "0", a = "1"] = (found[1] ?? found[2] ?? "").split(/[,\s/]+/).filter(Boolean);
  const shown = Number(a) * alpha;
  if (shown === 0) return null;
  const hex = [r, g, b].map((value) => Math.round(Number(value) * scale).toString(16).padStart(2, "0")).join("").toUpperCase();
  return { color: hex, transparency: Math.round((1 - shown) * 100) };
}

/** PowerPoint's dash for a CSS border style; the UA's inset rule of an `<hr>` draws solid. */
export function dashOf(style: string, id: string): "solid" | "dash" | "sysDot" {
  if (style === "double") throw noForm(id, "a double border");
  return style === "dashed" ? "dash" : style === "dotted" ? "sysDot" : "solid";
}

/**
 * A computed box-shadow or text-shadow as PowerPoint's outer shadow; undefined when there is none. PptxGenJS 4.0.1
 * writes an inner shadow it cannot close, and reads a zero blur, offset or angle as unset, so a zero is the nearest
 * value it keeps: a hair over, or 359° for a whole-degree angle.
 */
export function shadowOf(style: CSSStyleDeclaration, property: "box-shadow" | "text-shadow", alpha: number, id: string): PptxGenJS.ShadowProps | undefined {
  const css = style.getPropertyValue(property);
  if (css === "" || css === "none") return undefined;
  if (splitTop(css).length > 1) throw noForm(id, `${property} with more than one shadow`);
  if (/\binset\b/.test(css)) throw noForm(id, `${property}: inset`);
  const paint = color(css, id, alpha);
  if (paint === null) return undefined;
  const [x = 0, y = 0, blur = 0, spread = 0] = (css.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+(?=px)/g) ?? []).map(Number);
  if (spread !== 0) throw noForm(id, `${property} spread`);
  const angle = Math.round((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return {
    type: "outer", color: paint.color, opacity: 1 - paint.transparency / 100,
    blur: points(blur) || 0.01, offset: points(Math.hypot(x, y)) || 0.01, angle: angle || 359,
  };
}

/** A border side's line, which always has a colour. */
export type Line = PptxGenJS.ShapeLineProps & { color: string; transparency: number };
export type Side = { side: "Top" | "Right" | "Bottom" | "Left"; width: number; line: Line };

/** A box's borders, side by side, as PowerPoint lines; a side that draws nothing is left out. */
export function sidesOf(style: CSSStyleDeclaration, alpha: number, id: string): Side[] {
  return (["Top", "Right", "Bottom", "Left"] as const).flatMap((side) => {
    const width = px(style[`border${side}Width`]);
    const kind = style[`border${side}Style`];
    if (width === 0 || kind === "none" || kind === "hidden") return [];
    const paint = color(style[`border${side}Color`], id, alpha);
    if (paint === null) return [];
    return [{ side, width, line: { ...paint, width: points(width), dashType: dashOf(kind, id) } }];
  });
}

const sameLine = (a: PptxGenJS.ShapeLineProps, b: PptxGenJS.ShapeLineProps) =>
  a.color === b.color && a.width === b.width && a.transparency === b.transparency && a.dashType === b.dashType;

/** The one outline a box's borders make when all four are alike; null when they differ or some are missing. */
export function outlineOf(sides: readonly Side[]): Line | null {
  const [first] = sides;
  return first !== undefined && sides.length === 4 && sides.every(({ line }) => sameLine(line, first.line)) ? first.line : null;
}

/** A computed `linear-gradient(…)` drawn on a quarter-size canvas as CSS lays its line over the box, as a PNG. */
export function gradientPng(css: string, box: { w: number; h: number }, id: string): string | null {
  if (css === "" || css === "none") return null;
  const match = /^linear-gradient\((.*)\)$/.exec(css);
  if (match === null) throw noForm(id, css.slice(0, css.indexOf("(")));
  const parts = splitTop(match[1] ?? "");
  const angle = angleOf(parts);
  const w = Math.max(2, Math.round(box.w / 4));
  const h = Math.max(2, Math.round(box.h / 4));
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("this browser can't draw a gradient");
  const radians = (angle * Math.PI) / 180;
  const length = Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians));
  const dx = (Math.sin(radians) * length) / 2;
  const dy = (-Math.cos(radians) * length) / 2;
  const gradient = context.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
  parts.forEach((stop, index) => {
    const position = /\s([\d.]+)%$/.exec(stop);
    gradient.addColorStop(position ? Number(position[1]) / 100 : index / (parts.length - 1), position ? stop.slice(0, position.index).trim() : stop);
  });
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
  return canvas.toDataURL("image/png").replace(/^data:/, "");
}

const SIDES: Record<string, number> = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 };

function angleOf(parts: string[]): number {
  const [first = ""] = parts;
  if (/deg$/.test(first)) return parseFloat(parts.shift() ?? "180");
  if (/^to /.test(first)) return SIDES[parts.shift() ?? ""] ?? 180;
  return 180;
}

function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")") depth--;
    else if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

const UNDERLINE = { solid: "sng", double: "dbl", dotted: "dotted", dashed: "dash", wavy: "wavy" } as const;
const LINE_STYLES = ["solid", "double", "dotted", "dashed", "wavy"] as const;

/**
 * The decoration a run shows: its own and each ancestor's up to its block, as CSS draws them through descendants. A
 * line-through is solid or double in PowerPoint.
 */
export function decorationOf(from: Element, block: Element, window: Window, id: string): Pick<PptxGenJS.TextPropsOptions, "underline" | "strike"> {
  const decoration: Pick<PptxGenJS.TextPropsOptions, "underline" | "strike"> = {};
  for (let element: Element | null = from; element !== null; element = element === block ? null : element.parentElement) {
    const style = window.getComputedStyle(element);
    const lines = style.textDecoration.split(" ");
    const kind = LINE_STYLES.find((name) => lines.includes(name)) ?? "solid";
    if (lines.includes("underline")) {
      const tint = color(style.textDecorationColor, id)?.color;
      decoration.underline = { style: UNDERLINE[kind], ...(tint ? { color: tint } : {}) };
    }
    if (lines.includes("line-through")) decoration.strike = strikeOf(kind, id);
  }
  return decoration;
}

/** A line-through as PowerPoint draws one: solid or double only. */
function strikeOf(kind: (typeof LINE_STYLES)[number], id: string): "dblStrike" | "sngStrike" {
  if (kind !== "solid" && kind !== "double") throw noForm(id, `a ${kind} line-through`);
  return kind === "double" ? "dblStrike" : "sngStrike";
}
