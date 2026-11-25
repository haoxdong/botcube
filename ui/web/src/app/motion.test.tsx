import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { Arrives, Fades, Folds, foldAway, Glides, Rises, Shows, slide } from './motion';
import { forgetMotion } from './motion-tokens';

type Fade = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void; cancelled: boolean };
let fades: Fade[] = [];

// happy-dom has no Web Animations: each animate() is recorded, and a test finishes it by hand.
beforeEach(() => {
  fades = [];
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-quick: 150ms; --motion-move: 300ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
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
    expect(opacities(only())).toEqual([0]);
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

describe('Fades', () => {
  const buttons = (open: boolean) => <Fades>{open && <>
    <button key="cancel">Cancel editing</button>
    <button key="save">Save changes</button>
  </>}</Fades>;

  it('keeps each leaving child, inert, until its own fade out finishes', () => {
    const view = render(buttons(true));
    view.rerender(buttons(false));
    expect(screen.getByText('Cancel editing')).toHaveAttribute('inert');
    expect(screen.getByText('Save changes')).toHaveAttribute('inert');
    expect(fades.map(opacities)).toEqual([[0], [0]]);
    fades[1]?.finish();
    expect(screen.queryByText('Save changes')).toBeNull();
    expect(screen.getByText('Cancel editing')).toBeVisible();
    fades[0]?.finish();
    expect(screen.queryByText('Cancel editing')).toBeNull();
  });

  it('brings a leaving child back as the same element', () => {
    const view = render(<Fades>{<button>Retry upload</button>}</Fades>);
    const button = screen.getByText('Retry upload');
    view.rerender(<Fades>{false}</Fades>);
    view.rerender(<Fades>{<button>Retry upload</button>}</Fades>);
    expect(screen.getByText('Retry upload')).toBe(button);
    expect(button).not.toHaveAttribute('inert');
  });

  it('starts a fade out from its stylesheet, reading nothing, and turns a running one back from where it stands', () => {
    const style = window.getComputedStyle;
    let reads = 0;
    window.getComputedStyle = (element) => {
      if (element.tagName !== 'BUTTON') return style(element);
      reads += 1;
      return new Proxy(style(element), { get: (real, key) => (key === 'opacity' ? '0.4' : Reflect.get(real, key)) });
    };
    onTestFinished(() => { window.getComputedStyle = style; });
    const view = render(<Fades>{<button>Retry upload</button>}</Fades>);
    view.rerender(<Fades>{false}</Fades>);
    expect(reads).toBe(0);
    view.rerender(<Fades>{<button>Retry upload</button>}</Fades>);
    expect(fades.map(opacities)).toEqual([[0], [0.4, 1]]);
    expect(fades[0]?.cancelled).toBe(true);
  });

  it('crosses a keyed change in one stage: the old child fades out in its place as the new one fades in', () => {
    const view = render(<Fades>{<img key="a" alt="Picture" />}</Fades>);
    view.rerender(<Fades>{<span key="b">Mark</span>}</Fades>);
    expect(fades.map((fade) => [fade.element.tagName, ...opacities(fade)])).toEqual([['IMG', 0], ['SPAN', 0, 1]]);
    expect(screen.getByAltText('Picture').nextElementSibling).toBe(screen.getByText('Mark'));
  });

  it('fades in what is present at mount with `appear`, and says when the last child has left', () => {
    let left = 0;
    const list = (rows: string[]) => <Fades appear onExitComplete={() => { left += 1; }}>{rows.map((row) => <li key={row}>{row}</li>)}</Fades>;
    const view = render(list(['a.png']));
    expect(fades.map(opacities)).toEqual([[0, 1]]);
    view.rerender(list([]));
    expect(left).toBe(0);
    fades[1]?.finish();
    expect(left).toBe(1);
  });

  it('passes the child its own ref', () => {
    const seen: (Element | null)[] = [];
    render(<Fades>{<p ref={(node) => { seen.push(node); }}>Notice</p>}</Fades>);
    expect(seen[0]).toBe(screen.getByText('Notice'));
  });
});

describe('Fades folds', () => {
  const rows = (names: string[]) => <ul><Fades folds>{names.map((name) => <li key={name} className="collapsible"><div>{name}</div></li>)}</Fades></ul>;
  const heights = (fade: Fade) => fade.keyframes.filter((frame) => frame.height !== undefined).map((frame) => frame.height);
  const stub = (height: number) => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 100, height) });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect'); });
  };

  it('shows the rows present at mount at once, and grows a row that arrives from nothing to its height, fading it in', () => {
    stub(48);
    const view = render(rows(['Morning recap']));
    expect(fades).toEqual([]);
    view.rerender(rows(['Morning recap', 'Weekly digest']));
    expect(fades.map(heights)).toEqual([['0px', '48px']]);
    expect(opacities(only()).filter((opacity) => !Number.isNaN(opacity))).toEqual([0, 1, 1]);
    expect(only().options.duration).toBe(300);
  });

  it('closes a removed row to nothing, inert, before it leaves the list', () => {
    stub(48);
    const view = render(rows(['Morning recap', 'Weekly digest']));
    view.rerender(rows(['Morning recap']));
    expect(screen.getByText('Weekly digest').parentElement).toHaveAttribute('inert');
    expect(fades.map(heights)).toEqual([['48px', '0px']]);
    only().finish();
    expect(screen.queryByText('Weekly digest')).toBeNull();
  });

  it('opens a fold reversed mid-way to its settled height, border and sub-pixels included', () => {
    const folding = (box: Element) => fades.some((fade) => fade.element === box && !fade.cancelled);
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) { return new DOMRect(0, 0, 100, folding(this) ? 120.25 : 400.5); },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 398 });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect'); Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight'); });
    const view = render(rows(['Morning recap', 'Weekly digest']));
    view.rerender(rows(['Morning recap']));
    view.rerender(rows(['Morning recap', 'Weekly digest']));
    expect(fades.map((fade) => [fade.keyframes[0]?.height, fade.keyframes.at(-1)?.height])).toEqual([['400.5px', '0px'], ['120.25px', '400.5px']]);
  });
});

describe('foldAway', () => {
  it('folds a box from its height to nothing, and any edge it gives up, then is done; at once where motion is off', () => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 100, 60) });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect'); });
    const element = document.body.appendChild(document.createElement('div'));
    onTestFinished(() => element.remove());
    let done = 0;
    foldAway(element, () => { done += 1; }, { marginTop: '0px' });
    expect(only().keyframes.at(-1)).toEqual({ height: '0px', opacity: 0, marginTop: '0px' });
    expect(only().keyframes[0]?.height).toBe('60px');
    expect(done).toBe(0);
    only().finish();
    expect(done).toBe(1);
    document.documentElement.style.setProperty('--motion-move', '0ms');
    forgetMotion();
    onTestFinished(() => { document.documentElement.style.removeProperty('--motion-move'); });
    foldAway(element, () => { done += 1; });
    expect(done).toBe(2);
    expect(fades).toHaveLength(1);
  });
});

describe('Folds', () => {
  it('stays mounted, and moves its height from where it stood to where it lands once each time it opens or shuts', () => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) { return new DOMRect(0, 0, 100, this.getAttribute('aria-hidden') === 'true' ? 0 : 400); },
    });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect'); });
    const body = (open: boolean) => <Folds open={open} className="side-chats-body"><p>Side chat</p></Folds>;
    const view = render(body(true));
    const box = screen.getByText('Side chat').parentElement;
    view.rerender(body(true));
    expect(fades).toEqual([]);
    view.rerender(body(false));
    expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(box).toHaveAttribute('inert');
    view.rerender(body(true));
    expect(screen.getByText('Side chat').parentElement).toBe(box);
    expect(fades.map((fade) => fade.keyframes.map((frame) => frame.height))).toEqual([['400px', '0px'], ['0px', '400px']]);
    expect(fades.map((fade) => fade.options.duration)).toEqual([300, 300]);
  });
});

describe('Rises', () => {
  it('rises an arriving child into place once, on --motion-move', () => {
    render(<Rises arrives replaced={false}><div>Hello</div></Rises>);
    expect(fades).toHaveLength(1);
    expect(only().keyframes).toEqual([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }]);
    expect(only().options.duration).toBe(300);
  });

  it('leaves a child from transcript at rest, and stops a rise its message replaced', () => {
    const view = render(<Rises arrives={false} replaced={false}><div>Earlier</div></Rises>);
    expect(fades).toEqual([]);
    view.unmount();
    const rising = render(<Rises arrives replaced={false}><div>Answer</div></Rises>);
    rising.rerender(<Rises arrives replaced><div>Answer</div></Rises>);
    expect(only().cancelled).toBe(true);
  });
});

describe('Glides', () => {
  it('glides its box from where it was to where it lands when its dependency changes, once', async () => {
    let left = 0;
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(left, 0, 100, 50) });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect'); });
    const view = render(<Glides on dependency="shut">Chat</Glides>);
    left = 40;
    view.rerender(<Glides on dependency="shut">Chat</Glides>);
    view.rerender(<Glides on dependency="open">Chat</Glides>);
    left = 120;
    await Promise.resolve();
    expect(fades.map((fade) => fade.keyframes.map((frame) => frame.transform))).toEqual([['translate(-80px, 0px)', 'none']]);
  });
});

describe('slide', () => {
  it('slides a registered number from where it is to its target on --motion-move, then is done', () => {
    const element = document.body.appendChild(document.createElement('div'));
    onTestFinished(() => element.remove());
    element.style.setProperty('--sidebar-shown', '1');
    let done = 0;
    slide(element, '--sidebar-shown', 0, () => { done += 1; });
    expect(only().keyframes).toEqual([{ '--sidebar-shown': 1 }, { '--sidebar-shown': 0 }]);
    expect(element.style.getPropertyValue('--sidebar-shown')).toBe('0');
    only().finish();
    expect(done).toBe(1);
  });
});
