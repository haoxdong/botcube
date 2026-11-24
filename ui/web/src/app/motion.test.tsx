import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { Arrives, Shows } from './motion';

type Fade = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void; cancelled: boolean };
let fades: Fade[] = [];

// happy-dom has no Web Animations: each animate() is recorded, and a test finishes it by hand.
beforeEach(() => {
  fades = [];
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-quick: 150ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
  const running = new Map<Element, Fade[]>();
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value(this: Element) { return (running.get(this) ?? []).filter((fade) => !fade.cancelled).map((fade) => ({ cancel: () => { fade.cancelled = true; } })); } });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation: { onfinish: (() => void) | null; cancel: () => void } = { onfinish: null, cancel: () => { fade.cancelled = true; } };
      const fade: Fade = { element: this, keyframes, options, cancelled: false, finish: () => act(() => animation.onfinish?.()) };
      fades.push(fade);
      running.set(this, [...(running.get(this) ?? []), fade]);
      return animation;
    },
  });
  onTestFinished(() => {
    sheet.remove();
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  });
});
const opacities = (fade: Fade) => fade.keyframes.map((frame) => Number(frame.opacity));
/** The one fade the test expects. */
const only = () => {
  const [fade] = fades;
  if (!fade) throw new Error('No fade ran');
  return fade;
};

describe('Shows', () => {
  it('shows at once when present at mount', () => {
    render(<Shows when>Panel</Shows>);
    expect(screen.getByText('Panel')).toBeVisible();
    expect(fades).toEqual([]);
  });

  it('fades in once from nothing when it turns on', () => {
    const view = render(<Shows when={false}>Panel</Shows>);
    expect(screen.queryByText('Panel')).toBeNull();
    view.rerender(<Shows when>Panel</Shows>);
    expect(fades).toHaveLength(1);
    expect(opacities(only())).toEqual([0, 1]);
    expect(only().options).toMatchObject({ duration: 150, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  });

  it('fades out once, inert and keeping what it showed, then unmounts', () => {
    const view = render(<Shows when>{'Error'}</Shows>);
    view.rerender(<Shows when={false}>{null}</Shows>);
    const box = screen.getByText('Error');
    expect(box).toHaveAttribute('inert');
    expect(fades).toHaveLength(1);
    expect(opacities(only())).toEqual([1, 0]);
    expect(only().options.fill).toBe('forwards');
    only().finish();
    expect(screen.queryByText('Error')).toBeNull();
  });

  it('turns back from a fade out without unmounting', () => {
    const view = render(<Shows when>Panel</Shows>);
    view.rerender(<Shows when={false}>Panel</Shows>);
    view.rerender(<Shows when>Panel</Shows>);
    // The fade out stops where it is; happy-dom has no animated opacity, so no fade back in runs here.
    expect(only().cancelled).toBe(true);
    expect(screen.getByText('Panel')).not.toHaveAttribute('inert');
  });

  it('shows and hides at once where motion is off', () => {
    const off = document.head.appendChild(document.createElement('style'));
    off.textContent = ':root { --motion-quick: 0ms; }';
    onTestFinished(() => off.remove());
    const view = render(<Shows when>Panel</Shows>);
    view.rerender(<Shows when={false}>Panel</Shows>);
    expect(screen.queryByText('Panel')).toBeNull();
    expect(fades).toEqual([]);
  });
});

describe('Arrives', () => {
  it('shows a wait at once and fades in once what arrives after it, fading nothing out', () => {
    const view = render(<Arrives state="loading" waiting>Skeleton</Arrives>);
    expect(fades).toEqual([]);
    view.rerender(<Arrives state="loaded">List</Arrives>);
    expect(screen.queryByText('Skeleton')).toBeNull();
    expect(fades).toHaveLength(1);
    expect(opacities(only())).toEqual([0, 1]);
    expect(only().options.fill).toBe('none');
  });

  it('shows a new wait at once', () => {
    const view = render(<Arrives state="loaded">List</Arrives>);
    view.rerender(<Arrives state="loading" waiting>Skeleton</Arrives>);
    expect(fades).toEqual([]);
  });

  it('fades nothing while its state holds', () => {
    const view = render(<Arrives state="loaded">List</Arrives>);
    view.rerender(<Arrives state="loaded">List, updated</Arrives>);
    expect(fades).toEqual([]);
  });
});
