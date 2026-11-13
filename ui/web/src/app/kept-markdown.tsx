import { Lexer, type Token } from "marked";
import { Fragment, type ComponentType, type ReactNode } from "react";

type FullMarkdownState = { status: "ready"; Renderer: ComponentType<{ text: string }> } | { status: "error"; error: Error };
let full: FullMarkdownState | undefined;
let pending: Promise<void> | undefined;

function loadFullMarkdown() {
  return pending ??= import("./kept-streamdown").then(
    ({ default: Renderer }) => { full = { status: "ready", Renderer }; },
    (error: Error) => { full = { status: "error", error }; throw error; },
  );
}

function inlineToken(node: Token, key: number): ReactNode {
  if (node.type === "text" || node.type === "escape") {
    return /[\\`*_$[\]<>~@&]|www\.|:\//i.test(node.text) || /[^\S \t\r\n]/u.test(node.text) ? null : node.text;
  }
  if (node.type === "br") return <Fragment key={key}><br />{"\n"}</Fragment>;
  if (node.type !== "strong" && node.type !== "em") return null;
  const children = inline(node.tokens ?? []);
  if (children === null) return null;
  const strong = node.type === "strong";
  const Inline = strong ? "span" : "em";
  return <Inline key={key} className={strong ? "font-semibold" : undefined} data-streamdown={strong ? "strong" : undefined}>{children}</Inline>;
}

function inline(nodes: Token[]): ReactNode[] | null {
  const rendered: ReactNode[] = [];
  for (const [key, node] of nodes.entries()) {
    const child = inlineToken(node, key);
    if (child === null) return null;
    rendered.push(child);
  }
  return rendered;
}

function paragraphs(text: string) {
  const rendered: ReactNode[] = [];
  for (const [key, node] of Lexer.lex(text).entries()) {
    if (node.type === "space") continue;
    if (node.type !== "paragraph") return null;
    const children = inline(node.tokens ?? []);
    if (children === null) return null;
    rendered.push(<p key={key}>{children}</p>);
  }
  return rendered;
}

export function prepareKeptMarkdown(texts: string[]): Promise<void> | null {
  if (!texts.some((text) => paragraphs(text) === null)) return null;
  if (full?.status === "error") throw full.error;
  return full === undefined ? loadFullMarkdown() : null;
}

export default function KeptMarkdown({ text }: { text: string }) {
  const content = paragraphs(text);
  if (content !== null) return <div className="space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{content}</div>;
  if (full === undefined) throw loadFullMarkdown();
  if (full.status === "error") throw full.error;
  const Renderer = full.Renderer;
  return <Renderer text={text} />;
}
