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

it('leaves the page alone until the drawer first opens', () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const { rerender } = render(<Fixture held={false} />);
  scrollPage(300);
  rerender(<Fixture held={false} />);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(pageHeld()).toBe(false);
});
