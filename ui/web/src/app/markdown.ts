import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import remarkBreaks from "remark-breaks";
import { SHIKI_THEMES } from "./shiki-themes";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";

import { diagrams } from "./diagram-theme";
import { remarkBracketMath } from "./remark-bracket-math";
import { REPLY_MARKDOWN } from "./reply-markdown";

type Pluggable = (typeof defaultRehypePlugins)[string];

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const [harden, hardenOptions] = defaultRehypePlugins.harden as [unknown, object];

/**
 * A top-level list whose items are all bare markers (an answer such as "4." or "2026.") becomes a paragraph of its
 * source text: markdown parses a line that is only a list marker as an empty list item, which shows no text at all.
 */
function remarkBareListMarkersAsText() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    if (tree.children === undefined) return;
    tree.children = tree.children.map((node) =>
      node.type === "list" && node.children?.every((item) => item.children?.length === 0)
        ? {
            type: "paragraph",
            children: [
              { type: "text", value: String(file.value).slice(node.position?.start.offset, node.position?.end.offset) },
            ],
          }
        : node,
    );
  };
}

/** A GFM delimiter row: cells of dashes, each with an optional colon at either end. */
const DELIMITER_ROW = /^\s*\|?(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").length;

/**
 * Holds back a table until its delimiter row completes it: before then markdown reads its header as a
 * paragraph of pipes, which shows as raw text and, wrapped over several lines, collapses as the table forms. A reply's
 * last block of lines that each start with a pipe, outside code, waits until its second line is a delimiter row with
 * as many cells as its first. Streamdown runs it on every render, so the reply renderer passes it only while a Turn
 * runs: a finished reply shows its pipe lines as they are. Accepted: while a Turn runs, an earlier reply that
 * ends on pipe lines that are no table hides them until the Turn ends.
 */
export const tableInProgress = {
  name: "table-in-progress",
  handle(text: string) {
    const gap = text.lastIndexOf("\n\n");
    const start = gap === -1 ? 0 : gap + 2;
    const lines = text.slice(start).split("\n").filter((line, index, all) => line !== "" || index < all.length - 1);
    const fences = text.slice(0, start).match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0;
    if (lines.length === 0 || fences % 2 === 1 || !lines.every((line) => line.trimStart().startsWith("|"))) return text;
    const [header = "", delimiter] = lines;
    return delimiter !== undefined && DELIMITER_ROW.test(delimiter) && cells(delimiter) === cells(header) ? text : text.slice(0, start);
  },
};

/**
 * Streamdown's own plugins for an assistant message, except that:
 * - a line that is only a list marker shows as its text (remarkBareListMarkersAsText);
 * - a single newline is a line break, as in ChatGPT and Claude.ai, not a space (remarkBreaks);
 * - a link harden refuses (a citation to a ref such as `@s1.c3`, which is no URL) shows as its text alone rather than
 *   with harden's raw " [blocked]" marker. Still no link either way;
 * - a diagram draws in DESIGN.md's colours, not mermaid's default theme (diagrams).
 */
export const MARKDOWN_RENDERER = {
  plugins: { cjk, code, math, mermaid: diagrams },
  shikiTheme: SHIKI_THEMES,
  linkSafety: REPLY_MARKDOWN.linkSafety,
  remarkPlugins: [...Object.values(defaultRemarkPlugins), remarkBracketMath, remarkBareListMarkersAsText, remarkBreaks],
  rehypePlugins: Object.values({
    ...defaultRehypePlugins,
    harden: [harden, { ...hardenOptions, linkBlockPolicy: "text-only" }] as Pluggable,
  }),
};
