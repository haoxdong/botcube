import { useEffect, type RefObject } from 'react';

const MENUS = '.add-menu-positioner, .standard-popup-positioner';

/**
 * Marks the composer under `root` `data-open` from its text taking focus until the user leaves it, so a phone's
 * composer is one row at rest and two once tapped, even empty.
 */
export function watchComposerOpen(root: Element) {
  const box = () => root.querySelector<HTMLElement>('.copilotKitInput');
  const inComposer = (node: EventTarget | null) =>
    node instanceof Element && (box()?.contains(node) === true || node.closest(MENUS) !== null);
  const typing = () => document.activeElement instanceof HTMLTextAreaElement && box()?.contains(document.activeElement) === true;
  const mark = (open: boolean) => box()?.toggleAttribute('data-open', open);
  // iOS Safari moves focus to the page, not to a tapped button: the text's blur on a tap of the picker or Send is that tap.
  let tappedControl = false;

  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLTextAreaElement) || !inComposer(event.target)) return;
    tappedControl = false;
    mark(true);
  };
  const onPointerDown = (event: PointerEvent) => {
    tappedControl = inComposer(event.target) && !(event.target instanceof HTMLTextAreaElement);
    if (!inComposer(event.target) && !typing()) mark(false);
  };
  // `relatedTarget` is where focus lands. The picker's closing menu drops focus to the page before Base UI hands it
  // back to the picker, and a window losing focus leaves the text focused.
  const onFocusOut = (event: FocusEvent) => {
    const pickerToPage = event.relatedTarget === null && event.target instanceof Element && event.target.closest('.mep-dropdown') !== null;
    if (!tappedControl && !pickerToPage && !inComposer(event.relatedTarget) && !typing()) mark(false);
  };

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('pointerdown', onPointerDown, true);
  };
}

export function useComposerOpen(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    return element === null ? undefined : watchComposerOpen(element);
  }, [root]);
}
