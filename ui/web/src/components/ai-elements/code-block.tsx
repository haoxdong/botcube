"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { HighlighterGeneric, ThemedToken } from "shiki";

type Highlighter = HighlighterGeneric<"json", "github-light">;

// Loaded on the first code block, then shared by every other; Shiki itself loads then, not with the page.
let highlighter: Promise<Highlighter> | undefined;

// The block's tokens and the colors of its background and text.
interface Highlighted {
  tokens: ThemedToken[][];
  bg: string;
  fg: string;
}

// Highlighted code by its whole text, so a remounted block shows its colors without first flashing plain text.
const highlighted = new Map<string, Highlighted>();

// Plain text shown until the highlighter loads.
const plain = (code: string): Highlighted => ({
  tokens: code.split("\n").map((line) => (line ? [{ content: line, offset: 0 }] : [])),
  bg: "transparent",
  fg: "inherit",
});

async function highlight(code: string): Promise<Highlighted> {
  highlighter ??= import("shiki").then(({ createHighlighter }) =>
    createHighlighter({ langs: ["json"], themes: ["github-light"] }),
  );
  const loaded = await highlighter;
  const { tokens } = loaded.codeToTokens(code, { lang: "json", themes: { light: "github-light" } });
  // The theme's resolved colors, which are always set.
  const { bg, fg } = loaded.getTheme("github-light");
  const result = { tokens, bg, fg };
  highlighted.set(code, result);
  return result;
}

/** JSON, highlighted in the light GitHub theme. */
export const CodeBlock = ({ code }: { code: string }) => {
  const [async, setAsync] = useState<{ code: string; result: Highlighted } | null>(null);

  useEffect(() => {
    highlight(code).then(
      (result) => setAsync({ code, result }),
      (error) => console.error("Failed to highlight code:", error),
    );
  }, [code]);

  const shown = async?.code === code ? async.result : (highlighted.get(code) ?? plain(code));

  return (
    <div
      className="group relative w-full overflow-hidden rounded-md border bg-background text-foreground"
      data-language="json"
      style={{ containIntrinsicSize: "auto 200px", contentVisibility: "auto" }}
    >
      <div className="relative overflow-auto">
        <pre
          className="m-0 p-4 text-detail"
          style={{ backgroundColor: shown.bg, color: shown.fg }}
        >
          <code className="font-mono">
            {shown.tokens.map((line, lineIndex) => (
              <span className="block" key={lineIndex}>
                {line.length === 0
                  ? "\n"
                  : line.map((token, tokenIndex) => (
                      <span key={tokenIndex} style={token.htmlStyle as CSSProperties}>
                        {token.content}
                      </span>
                    ))}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
};
