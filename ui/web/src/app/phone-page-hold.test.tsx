import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { pageHeld, usePageHold } from './phone-page-hold';

function Fixture({ held }: { held: boolean }) {
  usePageHold(held);
  return null;
}

/** The page scrolled to `y`, as a scroll of the user's or the browser's clamp leaves it. */
function scrollPage(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  act(() => {
    fireEvent.scroll(window);
  });
}

afterEach(() => {
  scrollPage(0);
  document.documentElement.style.removeProperty('--page-scroll');
});

// A phone's chat scrolls the page; the open drawer's card showed the chat's top, without its header or composer, as
// the page under it scrolled. The drawer holds the page: the card offsets the chat by where it was scrolled, and on
// close the page scrolls back there.
it('holds the page where it was scrolled while the phone drawer is open, and scrolls back there when it closes (#3613)', () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const { rerender } = render(<Fixture held={false} />);
  scrollPage(1200);
  expect(pageHeld()).toBe(false);

  rerender(<Fixture held />);
  expect(document.documentElement.style.getPropertyValue('--page-scroll')).toBe('1200px');
  expect(pageHeld()).toBe(true);
  // The card is the screen, so the page clamps to its top: no scroll of the user's.
  scrollPage(0);
  expect(document.documentElement.style.getPropertyValue('--page-scroll')).toBe('1200px');

  rerender(<Fixture held={false} />);
  expect(pageHeld()).toBe(false);
  expect(scrollTo).toHaveBeenCalledWith(0, 1200);
});

// Signing out from the open drawer unmounts the app while it holds the page; the hold stayed on the page, so the
// next session's chat never followed its replies.
it('lets go of the page when the app unmounts with the phone drawer open (#3613)', () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const { unmount } = render(<Fixture held />);
  expect(pageHeld()).toBe(true);

  unmount();
  expect(pageHeld()).toBe(false);
});

// iOS Safari paints the strip behind the clock one flat colour while the page sits at its top; the held page, which
// clamped to its top, showed the drawer's grey there, not the drawer and the card beside it. Held, the page now
// scrolls past a runway above the screen, which the drawer and the card reach up into.
it('scrolls the held page past its runway, and lets go of it on release (#3640)', () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const root = document.documentElement;
  root.style.setProperty('--page-runway', '62px');
  const { rerender } = render(<Fixture held={false} />);
  scrollPage(1200);

  rerender(<Fixture held />);
  expect(root).toHaveAttribute('data-page-held');
  expect(scrollTo).toHaveBeenLastCalledWith(0, 62);

  rerender(<Fixture held={false} />);
  expect(root).not.toHaveAttribute('data-page-held');
  expect(scrollTo).toHaveBeenLastCalledWith(0, 1200);
  root.style.removeProperty('--page-runway');
});

// A real finger's swipe scrolled the held page on the maintainer's iPhone, from its runway toward its top, where Safari
// draws the strip behind the clock flat again. The held page goes back past its runway; once let go, it scrolls freely.
it('puts the held page back past its runway when something scrolls it (#3640)', () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const root = document.documentElement;
  root.style.setProperty('--page-runway', '62px');
  const { rerender } = render(<Fixture held={false} />);
  scrollPage(1200);
  rerender(<Fixture held />);
  scrollPage(62);
  scrollTo.mockClear();

  scrollPage(20);
  expect(scrollTo).toHaveBeenCalledWith(0, 62);

  rerender(<Fixture held={false} />);
  scrollTo.mockClear();
  scrollPage(900);
  expect(scrollTo).not.toHaveBeenCalled();
  root.style.removeProperty('--page-runway');
});

// On the maintainer's iPhone the open drawer's grey and the card stopped above Safari's bottom bar, over a white band.
// Held, the page also runs a runway below its viewport, as tall as the screen left under it: Safari's bar and the
// home bar.
it("runs the held page's runway under Safari's bottom bar (#3640)", () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const root = document.documentElement;
  root.style.setProperty('--page-runway', '62px');
  Object.defineProperty(window.screen, 'height', { value: 956, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 796, configurable: true });
  const { rerender } = render(<Fixture held />);
  expect(root.style.getPropertyValue('--page-runway-bottom')).toBe('98px');

  rerender(<Fixture held={false} />);
  expect(root.style.getPropertyValue('--page-runway-bottom')).toBe('');
  root.style.removeProperty('--page-runway');
});

it('leaves the page alone until the drawer first opens', () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const { rerender } = render(<Fixture held={false} />);
  scrollPage(300);
  rerender(<Fixture held={false} />);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(pageHeld()).toBe(false);
});
