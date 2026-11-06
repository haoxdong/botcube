import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchComposerOpen } from './composer-open';

let stop = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <p>An earlier reply</p>
    <div class="chat"><div class="copilotKitInput"><div data-layout="compact">
      <button data-testid="copilot-add-menu-button">+</button><textarea aria-label="Ask anything"></textarea>
      <div><button class="mep-pill">Model</button><button>Send</button></div>
    </div></div></div>
    <div class="standard-popup-positioner"><button>Effort</button></div>`;
  const root = document.querySelector('.chat');
  if (root === null) throw new Error('no chat');
  stop = watchComposerOpen(root);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const box = () => document.querySelector('.copilotKitInput');
const open = () => box()?.hasAttribute('data-open');
const el = (selector: string) => {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
};
const press = (target: Element) => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
/** Safari's tap on a button: the press, then the text's blur to the page. */
function tap(target: Element, focus = false) {
  press(target);
  if (focus && target instanceof HTMLElement) target.focus();
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  vi.runAllTimers();
}

// Like the Claude app's, a phone's composer rests on one row and opens to two once its text is tapped, even empty.
it('opens when its text takes focus, even empty', () => {
  expect(open()).toBe(false);
  tap(el('textarea'), true);
  expect(open()).toBe(true);
});

it('stays open while the picker, its menu and Send are tapped, though Safari blurs the text', () => {
  tap(el('textarea'), true);
  tap(el('.mep-pill'));
  expect(open()).toBe(true);
  tap(el('.standard-popup-positioner button'), true);
  expect(open()).toBe(true);
  tap(el('.mep-pill'), true);
  expect(open()).toBe(true);
});

it('closes on a tap outside, once the text no longer has focus', () => {
  tap(el('textarea'), true);
  tap(el('.mep-pill'));
  tap(el('p'));
  expect(open()).toBe(false);
});

it('keeps open a tap outside that leaves the text focused, with the keyboard up', () => {
  tap(el('textarea'), true);
  press(el('p'));
  vi.runAllTimers();
  expect(open()).toBe(true);
});

it('closes as the keyboard closes and the text loses focus with no tap', () => {
  tap(el('textarea'), true);
  el('textarea').blur();
  vi.runAllTimers();
  expect(open()).toBe(false);
});

it('closes when the keyboard closes after the picker was used and the text tapped again', () => {
  tap(el('textarea'), true);
  tap(el('.mep-pill'));
  tap(el('textarea'), true);
  el('textarea').blur();
  vi.runAllTimers();
  expect(open()).toBe(false);
});

it("leaves the composer at rest when its + opens a menu", () => {
  tap(el('[data-testid="copilot-add-menu-button"]'), true);
  expect(open()).toBe(false);
});

it('stops watching once stopped', () => {
  stop();
  tap(el('textarea'), true);
  expect(open()).toBe(false);
});
