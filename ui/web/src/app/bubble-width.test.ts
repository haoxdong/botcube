import { afterAll, beforeAll, expect, it } from 'vitest';

import { bubbleFlow, fitBubbles, huggedWidth, type Flow, type Paragraph } from './bubble-width';

const font = '400 14px Arial';
const paragraph = (text: string): Paragraph => ({ items: [{ text, font }], options: { whiteSpace: 'normal', wordBreak: 'normal' } });

/** Monospace at 10px a character, wrapped at spaces: the widest line `text` breaks into `width` wide. */
const widestLine = ({ items }: Paragraph, width: number) => {
  const words = items.map((item) => ('text' in item ? item.text : '')).join('').split(' ');
  let widest = 0;
  let line = '';
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && next.length * 10 > width) {
      widest = Math.max(widest, line.length * 10);
      line = word;
    } else line = next;
  }
  return Math.max(widest, line.length * 10);
};

it('hugs a wrapped paragraph to its widest line plus the bubble padding, not the width it wraps at', () => {
  // 200 wide less 32 of padding wraps "aaaaaaaaaaaa bbbbbbbbbbbbbbb" after the first word: 150 is the widest line.
  const bubble: Flow = { left: 16, right: 16, parts: [paragraph('aaaaaaaaaaaa bbbbbbbbbbbbbbb')] };
  expect(huggedWidth(bubble, 200, widestLine)).toBe(16 + 150 + 16);
});

it("measures a nested block's lines at the width left inside its edges, and adds those edges to them", () => {
  const widths: number[] = [];
  const list: Flow = { left: 20, right: 0, parts: [{ left: 0, right: 0, parts: [paragraph('cccc dddd')] }] };
  const bubble: Flow = { left: 16, right: 16, parts: [paragraph('ee'), list] };
  const width = huggedWidth(bubble, 200, (part, at) => {
    widths.push(at);
    return widestLine(part, at);
  });
  expect(widths).toEqual([168, 148]);
  expect(width).toBe(16 + 20 + 90 + 16);
});

it('takes an empty bubble as wide as its edges', () => {
  expect(huggedWidth({ left: 16, right: 16, parts: [] }, 200, widestLine)).toBe(32);
});

// happy-dom computes no initial white-space, word-break, letter-spacing, float, edges or inline display; a browser's
// are these, but letter-spacing's `normal`, which happy-dom drops, as its width.
const initial = document.createElement('style');
initial.textContent =
  'html { white-space: normal; word-break: normal; } * { float: none; margin: 0; border: 0 solid; padding: 0; letter-spacing: 0px; } strong, code, img, br { display: inline; }';
beforeAll(() => document.head.append(initial));
afterAll(() => initial.remove());

const bubbleOf = (markup: string) => {
  const bubble = document.createElement('div');
  bubble.style.padding = '10px 16px';
  bubble.innerHTML = markup;
  document.body.append(bubble);
  return bubble;
};

it("reads a reply's paragraphs, list indent, bold and inline code padding from the rendered bubble", () => {
  const bubble = bubbleOf(
    '<p>The curve <strong style="font-weight: 600">bull-steepened</strong>.<br>2s10s at <code style="padding: 1px 4px; border: 1px solid">+18bp</code></p><ul style="padding-left: 20px"><li>Two-year</li></ul>',
  );
  const flow = bubbleFlow(bubble);
  if (typeof flow === 'string') throw new Error(flow);

  expect([flow.left, flow.right]).toEqual([16, 16]);
  const [prose, list] = flow.parts;
  if (prose === undefined || !('parts' in prose) || list === undefined || !('parts' in list)) throw new Error('expected two blocks');
  const lines = prose.parts.map((part) => ('items' in part ? part.items.map((item) => (item.width === undefined ? [item.text, item.extraWidth ?? 0] : item.width)) : []));
  expect(lines).toEqual([
    [['The curve ', 0], ['bull-steepened', 0], ['.', 0]],
    [['2s10s at ', 0], ['+18bp', 10]],
  ]);
  const [bold] = prose.parts.flatMap((part) => ('items' in part ? part.items.slice(1, 2) : []));
  expect(bold?.width === undefined && bold?.font.includes('600')).toBe(true);
  expect([list.left, list.right]).toEqual([20, 0]);
  bubble.remove();
});

it("keeps the user's typed line breaks as pre-wrap text", () => {
  const bubble = bubbleOf('steepener\nor flattener?');
  bubble.style.whiteSpace = 'pre-wrap';
  const flow = bubbleFlow(bubble);
  if (typeof flow === 'string') throw new Error(flow);

  expect(flow.parts).toEqual([{ items: [expect.objectContaining({ text: 'steepener\nor flattener?' })], options: { whiteSpace: 'pre-wrap', wordBreak: 'normal' } }]);
  bubble.remove();
});

it('names what it cannot lay out, so the bubble keeps its CSS width', () => {
  const image = bubbleOf('<p>Chart: <img src="chart.png"></p>');
  const flex = bubbleOf('<div style="display: flex">a</div>');

  expect(bubbleFlow(image)).toBe('img');
  expect(bubbleFlow(flex)).toBe('div shown as flex');
  image.remove();
  flex.remove();
});

// A reply's file card is a flex box of a fixed width, which a hugging bubble has to measure.
it("reads a file's card as a line of its own as wide as the card", () => {
  const bubble = bubbleOf('<p>Here it is:</p><a class="reply-file" style="display: flex; margin-right: 4px">report.pdf</a>');
  const card = bubble.querySelector('a');
  if (card === null) throw new Error('the card');
  card.getBoundingClientRect = () => ({ width: 280.1 }) as DOMRect;
  const flow = bubbleFlow(bubble);
  if (typeof flow === 'string') throw new Error(flow);

  expect(flow.parts.at(-1)).toEqual({ items: [{ width: 284.25 }], options: { whiteSpace: 'normal', wordBreak: 'normal' } });
  bubble.remove();
});

// A reply's image box is sized before its picture comes, so a bubble that hugs it is as wide as the picture.
it("reads an image's box as a line of its own as wide as the box, before the picture comes", () => {
  const bubble = bubbleOf('<p>USDJPY:</p><span style="display: block"><div data-streamdown="image-wrapper" style="display: block"></div></span>');
  const box = bubble.querySelector('div');
  if (box === null) throw new Error('the box');
  box.getBoundingClientRect = () => ({ width: 573 }) as DOMRect;
  const flow = bubbleFlow(bubble);
  if (typeof flow === 'string') throw new Error(flow);

  expect(flow.parts.at(-1)).toEqual({ left: 0, right: 0, parts: [{ items: [{ width: 573 }], options: { whiteSpace: 'normal', wordBreak: 'normal' } }] });
  bubble.remove();
});

it('names a length a page without layout leaves uncomputed, rather than throwing', () => {
  initial.remove();
  const bubble = bubbleOf('<p>Rates fell.</p>');

  expect(bubbleFlow(bubble)).toBe('border-left-width not computed');
  bubble.remove();
  document.head.append(initial);
});

const listOf = (text: string) => {
  const list = document.createElement('div');
  list.innerHTML = `<div class="copilotKitAssistantMessage"><div class="cpk:prose"><div style="width: 240px"><p>${text}</p></div></div></div>`;
  document.body.append(list);
  return list;
};

it('lets a hugged reply span the column once a code block joins it', async () => {
  const list = listOf('Here is the curve:');
  const stop = fitBubbles(list);
  const bubble = list.querySelector<HTMLElement>('[class*="cpk:prose"] > div');
  if (bubble === null) throw new Error('the bubble');

  bubble.insertAdjacentHTML('beforeend', '<div data-streamdown="code-block"><pre>curve = 2s10s</pre></div>');
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  expect(bubble.style.width).toBe('');
  stop?.();
  list.remove();
});

it('lets a reply span its cap once a chart joins it, before the chart draws', async () => {
  const list = listOf('Inflation eased.');
  const stop = fitBubbles(list);
  const bubble = list.querySelector<HTMLElement>('[class*="cpk:prose"] > div');
  if (bubble === null) throw new Error('the bubble');

  bubble.insertAdjacentHTML('beforeend', '<span class="reply-chart" data-loading=""></span>');
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  expect(bubble.matches(':has(.reply-chart)')).toBe(true);
  expect(bubble.style.width).toBe('');
  stop?.();
  list.remove();
});

it('fits a streamed word before it paints, not a frame later inside the width fit to the words before it', async () => {
  const list = listOf('Hi Hao, I can pull rates');
  const stop = fitBubbles(list);
  const bubble = list.querySelector<HTMLElement>('[class*="cpk:prose"] > div');
  if (bubble === null) throw new Error('the bubble');
  let frames = 0;
  const count = () => { frames += 1; };
  requestAnimationFrame(count);

  bubble.querySelector('p')?.append(' and spreads');
  // The mutation's record arrives as a microtask, before any frame.
  await Promise.resolve();

  expect(frames).toBe(0);
  expect(bubble.style.width).toBe('');
  stop?.();
  list.remove();
});

it('fits the bubbles a list mounts with before it paints, not after its first resize and a frame', () => {
  const list = listOf('Hi Hao, I can pull rates');

  const stop = fitBubbles(list);

  // The kept chat mounts twice as a chat opens; each mount painted its replies unfitted, a line shorter.
  expect(list.querySelector<HTMLElement>('[class*="cpk:prose"] > div')?.style.width).toBe('');
  stop?.();
  list.remove();
});
