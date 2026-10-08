import type { Nodes, Root } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { InlineMath } from 'mdast-util-math';
import type { Extension, State, Tokenizer } from 'micromark-util-types';
import type {} from 'remark-parse';
import type { Plugin } from 'unified';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    bracketMath: 'bracketMath';
    bracketMathData: 'bracketMathData';
  }
}

const tokenizeBracketMath: Tokenizer = function (effects, ok, nok) {
  let close: 41 | 93;
  let dataOpen = false;
  return start;

  function start(code: Parameters<State>[0]): ReturnType<State> {
    effects.enter('bracketMath');
    effects.consume(code);
    return opening;
  }

  function opening(code: Parameters<State>[0]): ReturnType<State> {
    if (code !== 40 && code !== 91) return nok(code);
    close = code === 40 ? 41 : 93;
    effects.consume(code);
    return body;
  }

  function body(code: Parameters<State>[0]): ReturnType<State> {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      if (dataOpen) effects.exit('bracketMathData');
      dataOpen = false;
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return body;
    }
    if (!dataOpen) {
      effects.enter('bracketMathData');
      dataOpen = true;
    }
    effects.consume(code);
    return code === 92 ? closing : body;
  }

  function closing(code: Parameters<State>[0]): ReturnType<State> {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) return body(code);
    effects.consume(code);
    if (code !== close) return body;
    effects.exit('bracketMathData');
    effects.exit('bracketMath');
    return ok;
  }
};

const syntax: Extension = {
  text: { 92: { name: 'bracketMath', tokenize: tokenizeBracketMath } },
};

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    bracketMath(token) {
      const source = this.sliceSerialize(token);
      const value = source.slice(2, -2);
      const node: InlineMath = {
        type: 'inlineMath',
        value,
        data:
          source[1] === '['
            ? {
                hName: 'pre',
                hChildren: [
                  {
                    type: 'element',
                    tagName: 'code',
                    properties: {
                      className: ['language-math', 'math-display'],
                    },
                    children: [{ type: 'text', value }],
                  },
                ],
              }
            : {
                hName: 'code',
                hProperties: { className: ['language-math', 'math-inline'] },
                hChildren: [{ type: 'text', value }],
              },
      };
      this.enter(node, token);
      this.buffer();
    },
  },
  exit: {
    bracketMath(token) {
      this.resume();
      this.exit(token);
    },
  },
};

export const remarkBracketMath: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
};

const incompleteLinkUri = 'streamdown:incomplete-link';
const incompleteLinkSuffix = `(${incompleteLinkUri})`;

// A repaired link close can be consumed as math or escaped text. Its remaining
// protocol text is generated only when that URI never appeared in the input.
export const remarkRepairedBracketMath: Plugin<[string], Root> = function (original) {
  return (tree, file) => {
    const repaired = String(file.value);
    if (!repaired.endsWith(`]${incompleteLinkSuffix}`)) return;
    if (original.includes(incompleteLinkUri)) return;
    removeGeneratedSuffix(tree, original);
  };
};

function removeGeneratedSuffix(node: Nodes, original: string) {
  if (!('children' in node)) return;
  const children = node.children;
  const last = children.at(-1);
  if (last?.type === 'text' && last.value.endsWith(incompleteLinkSuffix)) {
    const followsMath = last.value === incompleteLinkSuffix && children.at(-2)?.type === 'inlineMath';
    const generatedLength = incompleteLinkSuffix.length + (followsMath ? 0 : 1);
    last.value = last.value.slice(0, -generatedLength) + (!followsMath && original.trimEnd().endsWith('\\') ? '\\' : '');
    if (last.value.length === 0) children.pop();
  } else if (last !== undefined) {
    removeGeneratedSuffix(last, original);
  }
}
