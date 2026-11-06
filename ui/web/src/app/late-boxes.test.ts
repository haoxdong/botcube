import { afterEach, beforeEach, expect, it } from 'vitest';

import { keepLateBoxes, keepSize, sizeOf } from './late-boxes';

const row = (id: string, html = '') => {
  const element = document.createElement('div');
  element.className = 'copilotKitMessage copilotKitAssistantMessage';
  element.dataset.messageId = id;
  element.innerHTML = `<div class="cpk:prose"><div>${html}</div></div>`;
  return element;
};
const DIAGRAM = '<div data-streamdown="mermaid-block"><div>mermaid</div><div><div class="my-4 min-h-[200px]"></div></div></div>';
/** Mutation observers report in a microtask, before the next frame paints. */
const observed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

let list: HTMLDivElement;
let stop: (() => void) | undefined;
beforeEach(() => {
  list = document.createElement('div');
  document.body.append(list);
  stop = keepLateBoxes(list);
});
afterEach(() => {
  stop?.();
  list.remove();
});

it('marks rows that join above rows already there joined, and rows added under them arrived, and not the first rows', async () => {
  const marker = document.createElement('div');
  marker.setAttribute('data-chat-earlier', '');
  list.append(marker, row('a'), row('b'));
  await observed();
  list.append(row('streamed'));
  await observed();
  marker.after(row('earlier-1'), row('earlier-2'));
  await observed();
  marker.remove();
  list.prepend(row('first'));
  await observed();

  const marks = (element: Element) => ['joined', 'arrived'].filter((mark) => element.hasAttribute(`data-${mark}`)).join();
  expect([...list.children].map((element) => [(element as HTMLElement).dataset.messageId, marks(element)])).toEqual([
    ['first', 'joined'],
    ['earlier-1', 'joined'],
    ['earlier-2', 'joined'],
    ['a', ''],
    ['b', ''],
    ['streamed', 'arrived'],
  ]);
});

it("gives a diagram the height it last drew at, keeps the height its box showed at, and keeps the drawn one for next time", async () => {
  list.append(row('diagram-reply', DIAGRAM));
  await observed();
  const block = list.querySelector<HTMLElement>('[data-streamdown="mermaid-block"]');
  if (!block) throw new Error('No diagram block');
  expect(block.style.getPropertyValue('--diagram-height')).toBe('200px');

  // Drawn: 400 by 600 in a 300px wide frame, which streamdown fits to 450px high.
  const body = block.lastElementChild;
  if (!body) throw new Error('No diagram body');
  body.innerHTML = '<div data-streamdown="mermaid"><div><div aria-label="Mermaid chart" role="img"><svg viewBox="0 0 400 600"></svg></div></div></div>';
  const frame = body.firstElementChild as HTMLElement;
  Object.defineProperty(frame, 'clientWidth', { value: 300 });
  await observed();

  expect(block.style.getPropertyValue('--diagram-height')).toBe('200px');
  expect(sizeOf('diagram:diagram-reply#0')).toEqual({ width: 0, height: 450 });
  // The row shows again, as when a thread opens again: its box takes the drawn height from its first frame.
  list.replaceChildren(row('diagram-reply', DIAGRAM));
  await observed();
  expect(list.querySelector<HTMLElement>('[data-streamdown="mermaid-block"]')?.style.getPropertyValue('--diagram-height')).toBe('450px');
});

it('keeps sizes across visits, the oldest going first past its limit', () => {
  keepSize('image:/artifacts/chart.png', { width: 1200, height: 640 });
  const stored = new Map(JSON.parse(localStorage.getItem('late-box-sizes') ?? '[]') as [string, unknown][]);
  expect(stored.get('image:/artifacts/chart.png')).toEqual({ width: 1200, height: 640 });
  for (let index = 0; index < 500; index += 1) keepSize(`image:${index}`, { width: 1, height: 1 });
  expect(sizeOf('image:/artifacts/chart.png')).toBeNull();
  expect(sizeOf('image:499')).toEqual({ width: 1, height: 1 });
});
