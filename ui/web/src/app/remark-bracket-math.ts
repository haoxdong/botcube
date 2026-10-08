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
