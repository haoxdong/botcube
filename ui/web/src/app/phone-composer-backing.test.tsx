import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useComposerBacking } from './phone-composer-backing';

function Fixture() {
  const backing = useRef<HTMLDivElement>(null);
  useComposerBacking(backing);
  return (
    <div className="copilotKitChat">
      <div className="rows" />
      <div ref={backing} className="chat-composer-backing" />
      <div data-testid="copilot-input-overlay" />
    </div>
  );
}

function box(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 440, width: 440, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

function backingIn(container: HTMLElement): HTMLElement {
  const backing = container.querySelector<HTMLElement>('.chat-composer-backing');
  if (!backing) throw new Error('The fixture renders no composer backing');
  Object.defineProperty(backing, 'offsetParent', { value: container.querySelector('.copilotKitChat'), configurable: true });
  return backing;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// With the keyboard up, iOS Safari draws the fixed composer at the bottom of what the keyboard leaves, and shows the
// page on below it, past what fixed content may paint, under its see-through keyboard bar. The page scrolls a phone's
// chat, so the chat showed there, where main's chat box, which ended above the composer, left the page colour. The
// backing lies in the page from the composer's bottom to the chat's end, following its scroll.
it("backs the page below the phone's composer with the keyboard up, as the page scrolls (#3613)", () => {
  let scrolled = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'copilot-input-overlay') return box(326, 449);
    if (this.classList.contains('copilotKitChat')) return box(-1000 - scrolled, 2000 - scrolled);
    return box(0, 0);
  });
  const { container } = render(<Fixture />);
  const backing = backingIn(container);
  act(() => {
    fireEvent(window, new Event('resize'));
  });
  expect({ top: backing.style.top, height: backing.style.height }).toEqual({ top: '1449px', height: '1551px' });

  scrolled = 200;
  act(() => {
    fireEvent.scroll(window);
  });
  expect({ top: backing.style.top, height: backing.style.height }).toEqual({ top: '1649px', height: '1351px' });
});

// With a hardware keyboard, iOS Safari swaps its toolbar for a short keyboard bar and shows the page on below the
// layout viewport, under that bar. The composer stood at the viewport's bottom, so a backing that stopped there let the
// chat show between the composer and the bar.
it("backs the page below the phone's composer to the chat's end, past the bottom of the viewport (#3613)", () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'copilot-input-overlay') return box(673, 796);
    if (this.classList.contains('copilotKitChat')) return box(-1000, 2000);
    return box(0, 0);
  });
  const { container } = render(<Fixture />);
  const backing = backingIn(container);
  act(() => {
    fireEvent(window, new Event('resize'));
  });
  expect({ top: backing.style.top, height: backing.style.height }).toEqual({ top: '1796px', height: '1204px' });
});
