import { zoomOf } from "@/lib/utils";
import { scrollParent } from "./chat-opening";
import { viewTop } from "./reading-hold";

type Card = { element: HTMLElement; at: number; height: number; top: number; scroll: number; words: string; stage: string; holding: boolean };
type View = { scroller: Element; zoom: number; top: number; bottom: number };

function readCard(element: HTMLElement, { scroller, zoom }: View, words: string, stage: string): Card {
  const box = element.getBoundingClientRect();
  return { element, at: box.top / zoom + scroller.scrollTop, height: box.height, top: box.top, scroll: scroller.scrollTop, words, stage, holding: false };
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// use-stick-to-bottom corrects a resize by a whole pixel; held, that is not the reader moving the card.
function holdCard(card: Card, was: Card | undefined, view: View, readerScrolled: boolean): boolean {
  if (was === undefined) return false;
  const top = (was.at - view.scroller.scrollTop) * view.zoom;
  if (top + was.height <= view.top || top >= view.bottom) return false;
  if (card.at !== was.at) {
    view.scroller.scrollTop = card.at - was.top / view.zoom;
    card.top = was.top;
  } else if (view.scroller.scrollTop === was.scroll || (was.holding && !readerScrolled)) card.top = was.top;
  card.scroll = view.scroller.scrollTop;
  return true;
}

// The bottom-follow library corrects a resize in the next frame, after inserted words have already painted.
export function keepArtifactReading(list: HTMLElement | null) {
  if (list === null) return;
  let previous = new Map<string, Card>();
  let width = innerWidth;
  let readerScrolled = false;
  const scrolledByReader = () => { readerScrolled = true; };
  const keyScrolled = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key) && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable]'))) readerScrolled = true;
  };
  const measure = () => {
    if (width !== innerWidth) previous.clear();
    width = innerWidth;
    const scroller = scrollParent(list);
    if (scroller === null) return;
    const view = { scroller, zoom: zoomOf(scroller), top: viewTop(scroller), bottom: scroller === document.scrollingElement ? innerHeight : scroller.getBoundingClientRect().bottom };
    const current = new Map<string, Card>();
    let held = false;
    for (const element of list.querySelectorAll<HTMLElement>('.artifact-reply-bubble .artifact-card')) {
      const bubble = element.closest<HTMLElement>('[data-artifact-turn]');
      if (bubble === null) continue;
      const key = JSON.stringify([bubble.dataset.artifactTurn, element.dataset.artifactId]);
      const was = previous.get(key);
      const words = bubble.querySelector('.chat-markdown')?.textContent ?? '';
      const card = readCard(element, view, words, bubble.dataset.artifactStage ?? '');
      const changing = was !== undefined && (was.element !== element || was.words !== words || was.stage !== card.stage || was.holding);
      if (!held && changing) held = holdCard(card, was, view, readerScrolled);
      card.holding = changing && list.querySelector(`[data-worklog-turn="${CSS.escape(bubble.dataset.artifactTurn ?? '')}"] .collapsible[data-closing]`) !== null;
      current.set(key, card);
    }
    previous = current;
    if (![...current.values()].some((card) => card.holding)) readerScrolled = false;
  };
  const changed = new MutationObserver(measure);
  changed.observe(list, { childList: true, characterData: true, attributes: true, attributeFilter: ["style", "data-artifact-stage"], subtree: true });
  const resized = new ResizeObserver(measure);
  resized.observe(list);
  const landed = () => { previous.clear(); measure(); };
  list.addEventListener('animationend', landed);
  document.addEventListener('scroll', measure, true);
  for (const type of ['wheel', 'touchmove']) window.addEventListener(type, scrolledByReader, { capture: true, passive: true });
  window.addEventListener('keydown', keyScrolled, true);
  measure();
  return () => {
    changed.disconnect(); resized.disconnect(); list.removeEventListener('animationend', landed); document.removeEventListener('scroll', measure, true);
    for (const type of ['wheel', 'touchmove']) window.removeEventListener(type, scrolledByReader, true);
    window.removeEventListener('keydown', keyScrolled, true);
  };
}
