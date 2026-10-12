import type { ComponentProps, ReactNode } from "react";
import type { ExtraProps } from "streamdown";

/**
 * Code as its words, so it wraps only at a space: browsers also break after a hyphen, splitting `--limit` into "--"
 * and "limit". A word with a character other than a letter or digit, where a browser may break, is held
 * together when it fits a 320px phone's line of answer or Worklog code, 26 characters, or a 641px window's, 60, there
 * (globals.css); a longer one, such as a URL, wraps as before. The rest stays plain text, so a long output costs few
 * elements.
 */
function codeWords(text: string) {
  const parts: ReactNode[] = [];
  let plain = "";
  text.split(/(\s+)/).forEach((part, index) => {
    const held = index % 2 === 0 && /[^\p{L}\p{N}]/u.test(part) && part.length <= 60;
    if (!held) {
      plain += part;
      return;
    }
    if (plain) parts.push(plain);
    plain = "";
    parts.push(<span key={index} className={part.length <= 26 ? "code-word" : "code-word-wide"}>{part}</span>);
  });
  if (plain) parts.push(plain);
  return parts;
}

/** Code wrapping only between its words; a component, so a closed Worklog step's output is never split. */
export function CodeWords({ text }: { text: string }) {
  return codeWords(text);
}

/** A reply's inline code, wrapping only between its words. */
export function InlineCode({ node: _node, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  return <code {...props}>{typeof children === "string" ? codeWords(children) : children}</code>;
}
