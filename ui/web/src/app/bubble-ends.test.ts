import { afterEach, beforeEach, expect, it } from 'vitest';

import { BUBBLE_ENDS, markBubbleEnds } from './bubble-ends';

/** Mutation observers report in a microtask, before the next frame paints. */
const observed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const reply = (id: string, markdown: string, after = '') => {
  const row = document.createElement('div');
  row.className = 'copilotKitMessage copilotKitAssistantMessage';
  row.dataset.id = id;
  row.innerHTML = `<div class="cpk:prose"><div class="chat-markdown">${markdown}</div></div>${after}`;
  return row;
};
const marked = (list: HTMLElement) => [...list.children].filter((row) => row.hasAttribute(BUBBLE_ENDS)).map((row) => (row as HTMLElement).dataset.id);

let list: HTMLDivElement;
let stop: (() => void) | undefined;
beforeEach(() => {
  list = document.createElement('div');
  document.body.append(list);
});
afterEach(() => {
  stop?.();
  list.remove();
});

it('marks a reply that ends at a bubble with words, past its hidden toolbar, and not one a tool row or an empty bubble ends', () => {
  list.append(
    reply('words', '<p>Rates rallied.</p>'),
    reply('toolbar', '<p>The curve steepened.</p>', '<div class="cpk:bg-transparent"></div>'),
    reply('tool', '<p>Checking.</p>', '<div class="tool-row"></div><div class="cpk:bg-transparent"></div>'),
    reply('empty', ''),
  );
  stop = markBubbleEnds(list);
  expect(marked(list)).toEqual(['words', 'toolbar']);
});

it('marks a streamed reply once its first word arrives, and unmarks it when a tool row follows its bubble', async () => {
  const streamed = reply('streamed', '');
  list.append(streamed);
  stop = markBubbleEnds(list);
  expect(marked(list)).toEqual([]);

  streamed.querySelector('.chat-markdown')?.append('Line 1');
  await observed();
  expect(marked(list)).toEqual(['streamed']);

  streamed.append(Object.assign(document.createElement('div'), { className: 'tool-row' }));
  await observed();
  expect(marked(list)).toEqual([]);
});

it('marks a reply that joins the list', async () => {
  stop = markBubbleEnds(list);
  list.append(reply('joined', '<p>Yields fell.</p>'));
  await observed();
  expect(marked(list)).toEqual(['joined']);
});
