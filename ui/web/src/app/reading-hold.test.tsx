import { render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { useRowsLandOnce } from './reading-hold';

const ROW = 100;
const VIEW = 300;

/** A chat of `total` 100px rows in a 300px scroll view, showing the last row until earlier ones join. */
function Chat({ total, atEnd }: { total: number; atEnd: boolean }) {
  const [first, setFirst] = useState(total - 1);
  const list = useRef<HTMLDivElement>(null);
  const earlier = useRef<HTMLDivElement>(null);
  useRowsLandOnce(list, earlier, atEnd, first, () => setFirst(first - 1));
  return (
    <div data-testid="copilot-chat">
      <div data-view style={{ overflowY: 'auto' }}>
        <div data-testid="copilot-scroll-content">
          <div ref={list}>
            {first > 0 && <div ref={earlier} data-marker />}
            {Array.from({ length: total - first }, (_, index) => <p key={first + index} className="row">{first + index}</p>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Lays the view out as a browser would: its rows' height, scrolled by `scrollTop`, the marker above the rows. */
function layout() {
  const top = new WeakMap<Element, number>();
  const viewOf = (element: Element) => element.closest('[data-view]');
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-view') ? VIEW : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-view') ? this.querySelectorAll('.row').length * ROW : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
    return top.get(this) ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) {
    top.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const view = viewOf(this);
    const y = this.hasAttribute('data-marker') && view ? -view.scrollTop : 0;
    return new DOMRect(0, y, 0, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('joins earlier rows before an opening chat paints until they fill its view, then starts the view at its end', () => {
  layout();
  const view = render(<Chat total={10} atEnd />);
  expect(view.container.querySelectorAll('.row')).toHaveLength(VIEW / ROW);
  const scroller = view.container.querySelector('[data-view]') as HTMLElement;
  expect(scroller.scrollTop).toBe(scroller.scrollHeight - VIEW);
});

it('leaves a chat opening at a given row as it lays out', () => {
  layout();
  const view = render(<Chat total={10} atEnd={false} />);
  expect(view.container.querySelectorAll('.row')).toHaveLength(1);
});
