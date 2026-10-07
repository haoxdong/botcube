import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { usePhoneSidebarSwipe as SwipeHook } from './phone-sidebar-swipe';

let usePhoneSidebarSwipe: typeof SwipeHook;
beforeAll(async () => {
  Object.defineProperty(window, 'ontouchstart', { value: null, configurable: true });
  ({ usePhoneSidebarSwipe } = await import('./phone-sidebar-swipe'));
});
beforeEach(() => {
  tick = 100;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect);
});
function Fixture({ enabled = true }: { enabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [linkTaps, setLinkTaps] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const swipe = usePhoneSidebarSwipe({ layoutRef, drawerRef, enabled, expanded, onExpandedChange: setExpanded });
  return <div ref={layoutRef} data-testid="layout" style={swipe.style} data-dragging={swipe.dragging}>
    <aside ref={drawerRef} data-testid="drawer" data-visible={swipe.visible}><svg data-testid="icon" /></aside>
    <button onClick={() => setExpanded(!expanded)}>Menu</button>
    <button onClick={() => setExpanded(false)}>Chat</button>
    <input aria-label="Input" />
    <p data-testid="bubble">A reply with <a href="#source" onClick={(event) => { event.preventDefault(); setLinkTaps(linkTaps + 1); }}>a link</a></p>
    <pre data-testid="code" style={{ overflowX: 'auto' }}><code>wide code</code></pre>
    <output>{expanded ? 'open' : 'closed'}</output>
    <output>{linkTaps} link taps</output>
  </div>;
}
let clock = 0;
let tick = 100;
function touch(type: string, x: number, y = 100, target = screen.getByTestId('layout'), count = 1) {
  clock += tick;
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, clientX: x, clientY: y, target };
  const touches = type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: count }, (_, i) => ({ ...point, identifier: i + 1 }));
  Object.defineProperties(event, { touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: [point] }, timeStamp: { value: clock } });
  void act(() => target.dispatchEvent(event));
  return event.defaultPrevented;
}
function settle(x: number, y = 100) { clock += 100; touch('touchend', x, y); }

describe('phone sidebar swipes', () => {
  it('registers a non-passive move listener before touchstart so WebKit can cancel drawer drags', () => {
    const listeners = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    render(<Fixture />);
    const layout = screen.getByTestId('layout');
    expect(listeners.mock.calls.some(([type, , options], index) =>
      listeners.mock.contexts[index] === layout && type === 'touchmove' &&
      typeof options === 'object' && options.passive === false)).toBe(true);
    touch('touchstart', 30);
    expect(touch('touchmove', 140, 104)).toBe(true);
    expect(screen.getByTestId('layout').style.getPropertyValue('--sidebar-drag-offset')).toBe('110px');
    settle(140, 104);
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
  it('tracks the finger using measured width and settles beyond halfway', () => {
    render(<Fixture />);
    touch('touchstart', 30);
    expect(touch('touchmove', 140)).toBe(true);
    expect(screen.getByTestId('layout').style.getPropertyValue('--sidebar-drag-offset')).toBe('110px');
    expect(screen.getByText('closed')).toBeInTheDocument();
    touch('touchmove', 220);
    settle(220);
    expect(screen.getByText('open')).toBeInTheDocument();
    touch('touchstart', 250, 100, screen.getByTestId('icon'));
    touch('touchmove', 70, 100, screen.getByTestId('drawer'));
    settle(70);
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
  it('opens from a right swipe anywhere on the chat, including on a bubble or link, without tapping it', () => {
    render(<Fixture />);
    const link = screen.getByText('a link');
    touch('touchstart', 150, 100, screen.getByTestId('bubble'));
    expect(touch('touchmove', 320, 100, screen.getByTestId('bubble'))).toBe(true);
    settle(320);
    expect(screen.getByText('open')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Chat'));
    touch('touchstart', 200, 100, link);
    expect(touch('touchmove', 380, 100, link)).toBe(true);
    settle(380);
    fireEvent.click(link, { detail: 1 });
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('0 link taps')).toBeInTheDocument();
  });
  it('leaves a right drag on sideways-scrolling content or selected text to that content', () => {
    render(<Fixture />);
    const code = screen.getByTestId('code');
    Object.defineProperties(code, { scrollWidth: { value: 600 }, clientWidth: { value: 300 } });
    touch('touchstart', 150, 100, code);
    expect(touch('touchmove', 330, 100, code)).toBe(false);
    settle(330);
    expect(screen.getByText('closed')).toBeInTheDocument();
    window.getSelection()?.selectAllChildren(screen.getByTestId('bubble'));
    touch('touchstart', 150, 100, screen.getByTestId('bubble'));
    expect(touch('touchmove', 330, 100, screen.getByTestId('bubble'))).toBe(false);
    settle(330);
    window.getSelection()?.removeAllRanges();
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
  it('snaps short drags back and restores canceled drags', () => {
    render(<Fixture />);
    touch('touchstart', 30); touch('touchmove', 90); settle(90);
    expect(screen.getByText('closed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Menu'));
    touch('touchstart', 260); touch('touchmove', 40); touch('touchcancel', 40);
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByTestId('layout')).toHaveAttribute('data-dragging', 'false');
  });
  it('leaves vertical scroll, reserved edges, inputs, wrong direction alone', () => {
    render(<Fixture />);
    touch('touchstart', 30); expect(touch('touchmove', 33, 160)).toBe(false); settle(33, 160);
    touch('touchstart', 20); expect(touch('touchmove', 240)).toBe(false); settle(240);
    touch('touchstart', 30); expect(touch('touchmove', 10)).toBe(false); settle(10);
    touch('touchstart', 30, 100, screen.getByLabelText('Input')); expect(touch('touchmove', 230, 100, screen.getByLabelText('Input'))).toBe(false); settle(230);
    expect(screen.getByText('closed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Menu'));
    expect(screen.getByText('open')).toBeInTheDocument();
  });
  it('abandons multi-touch and resize, and suppresses only a swipe-generated click', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByText('Menu'));
    touch('touchstart', 250); touch('touchmove', 210); touch('touchmove', 190, 100, screen.getByTestId('layout'), 2);
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByTestId('layout')).toHaveAttribute('data-dragging', 'false');
    touch('touchend', 190);
    touch('touchstart', 250); touch('touchmove', 210);
    fireEvent(window, new Event('resize'));
    expect(screen.getByTestId('layout')).toHaveAttribute('data-dragging', 'false');
    touch('touchend', 210);
    touch('touchstart', 250); touch('touchmove', 210); settle(210);
    fireEvent.click(screen.getByText('Chat'), { detail: 1 });
    expect(screen.getByText('open')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Chat'));
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
  it('settles in the recent flick direction and ignores velocity after a pause', () => {
    render(<Fixture />);
    tick = 10;
    touch('touchstart', 30); touch('touchmove', 50); touch('touchmove', 90); touch('touchend', 90);
    expect(screen.getByText('open')).toBeInTheDocument();
    touch('touchstart', 250); touch('touchmove', 230); touch('touchmove', 190); touch('touchend', 190);
    expect(screen.getByText('closed')).toBeInTheDocument();
    touch('touchstart', 30); touch('touchmove', 50); touch('touchmove', 90);
    tick = 500;
    touch('touchend', 90);
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
  it('clamps travel and lets navigation interrupt without reopening the drawer', () => {
    render(<Fixture />);
    touch('touchstart', 30); touch('touchmove', 500);
    expect(screen.getByTestId('layout').style.getPropertyValue('--sidebar-drag-offset')).toBe('300px');
    settle(500);
    touch('touchstart', 250); touch('touchmove', 190);
    fireEvent.click(screen.getByText('Chat'));
    expect(screen.getByTestId('layout')).toHaveAttribute('data-dragging', 'false');
    settle(190);
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
  it('keeps presentation mounted while settling then removes the closed drawer', async () => {
    render(<Fixture />);
    touch('touchstart', 30); touch('touchmove', 90); settle(90);
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-visible', 'true');
    expect(screen.getByText('closed')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('drawer')).toHaveAttribute('data-visible', 'false'));
  });
  it('does not recognize gestures when disabled', () => {
    render(<Fixture enabled={false} />);
    touch('touchstart', 30); expect(touch('touchmove', 230)).toBe(false); settle(230);
    expect(screen.getByText('closed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Menu'));
    expect(screen.getByText('open')).toBeInTheDocument();
  });
});
