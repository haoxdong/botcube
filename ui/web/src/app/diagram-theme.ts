import { createMermaidPlugin, mermaid, type DiagramPlugin } from "@streamdown/mermaid";

const COLOURS = ["text", "text-muted", "fill", "line", "white", "blue", "bubble", "red", "green"] as const;
type Palette = Record<(typeof COLOURS)[number], string>;

function themeVariables(c: Palette): Record<string, unknown> {
  const { text, "text-muted": muted, fill, line, white, blue, bubble, red, green } = c;
  const series = [blue, green, red, muted, bubble, line];
  const each = (count: number, name: (i: number) => string, colour: (i: number) => string) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), colour(i)]));
  return {
    background: fill,
    primaryColor: white, primaryTextColor: text, primaryBorderColor: line,
    secondaryColor: white, secondaryTextColor: text, secondaryBorderColor: line,
    tertiaryColor: fill, tertiaryTextColor: text, tertiaryBorderColor: line,
    mainBkg: white, secondBkg: white, nodeBorder: line, nodeTextColor: text, textColor: text, titleColor: text, labelColor: text,
    lineColor: muted, defaultLinkColor: muted, arrowheadColor: muted, edgeLabelBackground: fill,
    clusterBkg: fill, clusterBorder: line,
    noteBkgColor: white, noteBorderColor: line, noteTextColor: text,
    errorBkgColor: white, errorTextColor: red,
    actorBkg: white, actorBorder: line, actorTextColor: text, actorLineColor: line, signalColor: muted, signalTextColor: text,
    labelBoxBkgColor: white, labelBoxBorderColor: line, labelTextColor: text, loopTextColor: text,
    activationBkgColor: line, activationBorderColor: line, sequenceNumberColor: white,
    ...each(12, (i) => `cScale${i}`, () => white), ...each(12, (i) => `cScalePeer${i}`, () => line),
    ...each(12, (i) => `cScaleLabel${i}`, () => text), ...each(12, (i) => `cScaleInv${i}`, () => white),
    ...each(8, (i) => `fillType${i}`, () => white),
    ...each(12, (i) => `pie${i + 1}`, (i) => series[i % series.length] ?? muted),
    pieStrokeColor: white, pieOuterStrokeColor: white, pieTitleTextColor: text, pieSectionTextColor: text, pieLegendTextColor: text, pieOpacity: "1",
    sectionBkgColor: white, altSectionBkgColor: fill, sectionBkgColor2: white, excludeBkgColor: line, gridColor: line, todayLineColor: red,
    taskBkgColor: bubble, taskBorderColor: blue, activeTaskBkgColor: bubble, activeTaskBorderColor: blue,
    doneTaskBkgColor: line, doneTaskBorderColor: muted, critBkgColor: white, critBorderColor: red,
    taskTextColor: text, taskTextLightColor: text, taskTextDarkColor: text, taskTextOutsideColor: text, taskTextClickableColor: blue,
    classText: text, stateBkg: white, stateLabelColor: text, altBackground: white, transitionColor: muted, transitionLabelColor: text,
    compositeBackground: fill, compositeTitleBackground: white, compositeBorder: line, innerEndBackground: muted, specialStateColor: muted,
    attributeBackgroundColorOdd: white, attributeBackgroundColorEven: white,
    relationColor: muted, relationLabelColor: text, relationLabelBackground: fill,
    quadrant1Fill: white, quadrant2Fill: white, quadrant3Fill: white, quadrant4Fill: white,
    ...each(4, (i) => `quadrant${i + 1}TextFill`, () => text),
    quadrantPointFill: blue, quadrantPointTextFill: text, quadrantXAxisTextFill: text, quadrantYAxisTextFill: text, quadrantTitleFill: text,
    quadrantInternalBorderStrokeFill: line, quadrantExternalBorderStrokeFill: line,
    xyChart: {
      backgroundColor: fill, titleColor: text, plotColorPalette: series.join(","),
      xAxisLabelColor: text, xAxisTitleColor: text, xAxisTickColor: muted, xAxisLineColor: muted,
      yAxisLabelColor: text, yAxisTitleColor: text, yAxisTickColor: muted, yAxisLineColor: muted,
    },
    ...each(8, (i) => `git${i}`, (i) => series[i % 4] ?? muted), ...each(8, (i) => `gitInv${i}`, () => white),
    ...each(8, (i) => `gitBranchLabel${i}`, () => white),
    commitLabelColor: text, commitLabelBackground: white, tagLabelColor: text, tagLabelBackground: white, tagLabelBorder: line,
  };
}

/**
 * What mermaid draws in colours no theme variable reaches, named by what it is rather than by mermaid's hardcoded
 * value: black strokes set as SVG attributes (a sequence diagram's cross arrowhead, a timeline's or journey's axis), an
 * edge label's background faded to half, and a journey's sections, task lines, faces and people (mermaid appends to
 * `actorColours` rather than replacing it). It sits in the diagram's own inline <style>, so the tokens resolve as they are.
 */
const THEME_CSS = `[stroke=black], .mouth, .task-line, .face ~ g circle { stroke: var(--color-text-muted); }
.face ~ g circle { fill: var(--color-text-muted); }
.journey-section, [class^="task task-type-"] { stroke: var(--color-line); }
.labelBkg { background-color: var(--color-fill); }
.face { fill: var(--color-white); stroke: var(--color-text-muted); }
circle[class^=actor-] { fill: var(--color-text-muted); stroke: var(--color-text); }
.actor-0 { fill: var(--color-blue); } .actor-1 { fill: var(--color-green); } .actor-2 { fill: var(--color-red); }`;

/** The ten colours as tokens.css resolves them: mermaid works out shades from its variables, so a `var()` won't do. */
function palette(): Palette {
  const root = getComputedStyle(document.documentElement);
  const read = (name: (typeof COLOURS)[number]) => {
    const value = root.getPropertyValue(`--color-${name}`).trim();
    if (value === "") throw new Error(`tokens.css defines no --color-${name} for diagrams`);
    return value;
  };
  return Object.fromEntries(COLOURS.map((name) => [name, read(name)])) as Palette;
}

let themed: DiagramPlugin | undefined;

export const diagrams: DiagramPlugin = {
  ...mermaid,
  getMermaid: (config) => (themed ??= createMermaidPlugin({ config: { theme: "base", themeVariables: themeVariables(palette()), themeCSS: THEME_CSS } })).getMermaid(config),
};
