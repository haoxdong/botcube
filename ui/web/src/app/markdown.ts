import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import remarkBreaks from "remark-breaks";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";

import { remarkBracketMath } from "./remark-bracket-math";

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

/**
 * Streamdown's own plugins for an assistant message, except that:
 * - a line that is only a list marker shows as its text (remarkBareListMarkersAsText);
 * - a single newline is a line break, as in ChatGPT and Claude.ai, not a space (remarkBreaks);
 * - a link harden refuses (a citation to a ref such as `@s1.c3`, which is no URL) shows as its text alone rather than
 *   with harden's raw " [blocked]" marker. Still no link either way.
 */
export const MARKDOWN_RENDERER = {
  plugins: { cjk, code, math, mermaid },
  linkSafety: { enabled: false },
  remarkPlugins: [...Object.values(defaultRemarkPlugins), remarkBracketMath, remarkBareListMarkersAsText, remarkBreaks],
  rehypePlugins: Object.values({
    ...defaultRehypePlugins,
    harden: [harden, { ...hardenOptions, linkBlockPolicy: "text-only" }] as Pluggable,
  }),
};
