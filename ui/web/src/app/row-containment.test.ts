import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CONTAINED, containRows } from './row-containment';

/** A ResizeObserver whose entries the test delivers, as a browser does after a layout. */
class LayoutObserver {
  static all: LayoutObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { LayoutObserver.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  /** A layout: each observed element reports `height`, and `width` for the list. */
  report(height: (target: Element) => number, width = 600) {
    const entries = [...this.targets].map((target) => ({ target, contentRect: { width }, borderBoxSize: [{ blockSize: height(target), inlineSize: width }] }));
    if (entries.length > 0) this.callback(entries as unknown as ResizeObserverEntry[], this);
  }
}
const frames = vi.hoisted(() => new Set<() => void>());
vi.mock('framer-motion', () => ({ frame: { read: (run: () => void) => frames.add(run) }, cancelFrame: (run: () => void) => frames.delete(run) }));
const paint = () => { const pending = [...frames]; frames.clear(); for (const run of pending) run(); };
const layout = (height: (target: Element) => number, width?: number) => { for (const observer of LayoutObserver.all) observer.report(height, width); paint(); };
/** Mutation observers report in a microtask. */
const observed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const row = (id: string) => {
  const element = document.createElement('div');
  element.dataset.messageId = id;
  return element;
};
const state = (list: HTMLElement) => [...list.children].map((element) => [
  (element as HTMLElement).dataset.messageId,
  element.hasAttribute(CONTAINED) ? (element as HTMLElement).style.getPropertyValue('contain-intrinsic-block-size') : 'live',
]);

let list: HTMLDivElement;
let stop: (() => void) | undefined;
beforeEach(() => {
  LayoutObserver.all = [];
  frames.clear();
  vi.stubGlobal('ResizeObserver', LayoutObserver);
  list = document.createElement('div');
  list.append(row('a'), row('b'), row('c'));
  document.body.append(list);
  stop = containRows(list);
});
afterEach(() => {
  stop?.();
  list.remove();
  vi.unstubAllGlobals();
});

it('contains each row only once laid out, at the height it was laid out at, and keeps the last row live', async () => {
  expect(state(list)).toEqual([['a', 'live'], ['b', 'live'], ['c', 'live']]);
  layout((target) => (target === list ? 900 : 120));
  expect(state(list)).toEqual([['a', 'auto 120px'], ['b', 'auto 120px'], ['c', 'live']]);

  // A Turn starts: the question joins, and the row before it is no longer last; it is contained after the next layout.
  list.append(row('question'));
  await observed();
  expect(state(list)).toEqual([['a', 'auto 120px'], ['b', 'auto 120px'], ['c', 'live'], ['question', 'live']]);
  layout((target) => (target === list ? 1000 : 64));
  expect(state(list)).toEqual([['a', 'auto 120px'], ['b', 'auto 120px'], ['c', 'auto 64px'], ['question', 'live']]);
});

it('lays every row out again at a new width, and contains them at their new heights', () => {
  layout(() => 120);
  expect(state(list)).toEqual([['a', 'auto 120px'], ['b', 'auto 120px'], ['c', 'live']]);
  layout(() => 120, 600);
  expect(state(list)).toEqual([['a', 'auto 120px'], ['b', 'auto 120px'], ['c', 'live']]);

  // Narrower: the list reports first, and every row turns live until it reports its new height.
  const [rows, width] = LayoutObserver.all;
  width?.report(() => 0, 400);
  paint();
  expect(state(list)).toEqual([['a', 'live'], ['b', 'live'], ['c', 'live']]);
  rows?.report(() => 180, 400);
  paint();
  expect(state(list)).toEqual([['a', 'auto 180px'], ['b', 'auto 180px'], ['c', 'live']]);
});

it('commits containment outside the ResizeObserver delivery that measured the rows', () => {
  const [rows] = LayoutObserver.all;
  rows?.report(() => 120);
  expect(state(list)).toEqual([['a', 'live'], ['b', 'live'], ['c', 'live']]);
  paint();
  expect(state(list)).toEqual([['a', 'auto 120px'], ['b', 'auto 120px'], ['c', 'live']]);
});

it('cancels pending containment when the list is disposed', () => {
  const [rows] = LayoutObserver.all;
  rows?.report(() => 120);
  stop?.();
  paint();
  expect(state(list)).toEqual([['a', 'live'], ['b', 'live'], ['c', 'live']]);
  expect(frames.size).toBe(0);
});
