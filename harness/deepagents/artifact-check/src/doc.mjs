import { Lexer } from 'marked';

import { IMAGE_SOURCE } from './subset.mjs';

// @tiptap/markdown parses with marked, so the checker lexes with marked too.

/** @typedef {import('./check.mjs').CheckError} CheckError */

// marked resolves a `def` (a link's reference) into its link.
const SHOWN = new Set([
  'space', 'heading', 'paragraph', 'text', 'escape', 'strong', 'em', 'del', 'codespan', 'code', 'br', 'hr',
  'blockquote', 'list', 'list_item', 'checkbox', 'table', 'link', 'image', 'def',
]);

const NEAREST = {
  b: '**bold**', strong: '**bold**', i: '_italic_', em: '_italic_', u: '**bold** or _italic_', s: '~~struck~~',
  del: '~~struck~~', strike: '~~struck~~', a: '[text](https://…)', img: '![alt](data:image/png;base64,…)',
  h1: '# Heading', h2: '## Heading', h3: '### Heading', h4: '#### Heading', h5: '##### Heading', h6: '###### Heading',
  ul: '- item', ol: '1. item', li: '- item', table: 'a pipe table, | a | b |', tr: 'a pipe table row, | a | b |',
  td: 'a pipe table cell', th: 'a pipe table header row', br: 'a blank line between paragraphs',
  hr: '---', blockquote: '> quote', pre: 'a ``` fenced code block', code: '`code`',
  input: '- [ ] task', p: 'a paragraph: the text alone, with a blank line before and after',
};
const PLAIN = 'the text alone, with emphasis as **bold** or _italic_';

/**
 * @param {Record<string, string>} files
 * @returns {Promise<CheckError[]>}
 */
export async function checkDoc(files) {
  return Object.entries(files).flatMap(([file, text]) => errorsIn(file, text));
}

/** @returns {CheckError[]} */
function errorsIn(file, text) {
  const source = text.replace(/\r\n?/g, '\n');
  const errors = [];
  const reported = new Set();
  const at = (offset) => {
    const before = source.slice(0, offset);
    return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
  };
  const visit = (tokens, from) => {
    let offset = from;
    for (const token of tokens) {
      const found = source.indexOf(token.raw, offset);
      const start = found < 0 ? offset : found;
      const where = { file, ...at(start) };
      if (token.type === 'html') {
        const error = htmlError(token.raw, reported);
        if (error !== null) errors.push({ ...where, ...error });
      } else if (token.type === 'image' && !IMAGE_SOURCE.test(token.href)) {
        errors.push({
          ...where, element: `![${token.text}](${token.href.slice(0, 40)})`,
          message: 'is an image the Doc would load from elsewhere, which the app never loads',
          nearest: 'the image itself as a data: URI, ![alt](data:image/png;base64,…)',
        });
      } else if (!SHOWN.has(token.type)) {
        errors.push({ ...where, element: token.raw.trim().slice(0, 40), message: 'is Markdown the Doc does not show', nearest: PLAIN });
      }
      for (const children of childrenOf(token)) visit(children, start);
      if (found >= 0) offset = start + token.raw.length;
    }
  };
  visit(new Lexer({ gfm: true }).lex(source), 0);
  return errors;
}

function childrenOf(token) {
  const children = [token.tokens, token.items].filter(Boolean);
  if (token.type === 'table') children.push(...[...token.header, ...token.rows.flat()].map((cell) => cell.tokens));
  return children;
}

function htmlError(raw, reported) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<!--')) {
    return { element: '<!-- … -->', message: 'is an HTML comment, which the Doc does not keep', nearest: 'nothing: leave it out' };
  }
  const [, closing, name = ''] = /^<(\/?)([a-zA-Z][\w-]*)/.exec(trimmed) ?? [];
  const tag = name.toLowerCase();
  if (closing && reported.has(tag)) return null;
  reported.add(tag);
  return {
    element: tag ? `<${closing ?? ''}${tag}>` : trimmed.slice(0, 40),
    message: 'is HTML, which the Doc does not keep: its viewer shows only the text, and the next save drops the HTML',
    nearest: NEAREST[tag] ?? PLAIN,
  };
}
