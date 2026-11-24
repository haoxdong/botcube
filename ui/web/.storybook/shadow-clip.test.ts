import { describe, expect, it } from 'vitest';

import { clipArea, shadowClips, shadowReach, type ClipStyle, type Layout } from './shadow-clip';

const SHADOW_REST = 'rgba(0, 0, 0, 0.08) 0px 1px 3px 0px, rgba(0, 0, 0, 0.08) 0px 4px 16px 0px';

/** A box laid out at `rect`, no border, its content `scroll` big. */
function laidOut(rect: { left: number; top: number; width: number; height: number }, scroll = { width: rect.width, height: rect.height, left: 0, top: 0 }): Layout {
  return {
    getBoundingClientRect: () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }),
    clientLeft: 0,
    clientTop: 0,
    clientWidth: rect.width,
    clientHeight: rect.height,
    scrollLeft: scroll.left,
    scrollTop: scroll.top,
    scrollWidth: scroll.width,
    scrollHeight: scroll.height,
  };
}
const style = (overrides: Partial<ClipStyle>): ClipStyle => ({
  overflowX: 'visible',
  overflowY: 'visible',
  contain: 'none',
  contentVisibility: 'visible',
  overflowClipMargin: '0px',
  ...overrides,
});
function place(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
  for (const [key, value] of Object.entries(laidOut(rect))) Object.defineProperty(element, key, { value, configurable: true });
}

describe('shadowReach', () => {
  it("reaches as far as the rest shadow's widest blur, lower below", () => {
    expect(shadowReach(SHADOW_REST)).toEqual({ top: 12, right: 16, bottom: 20, left: 16 });
  });

  it('reaches nowhere for no shadow or an inset one', () => {
    expect(shadowReach('none')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(shadowReach('rgba(0, 0, 0, 0.1) 0px 2px 8px 0px inset')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('clipArea', () => {
  const box = { left: 100, top: 200, width: 300, height: 80 };

  it('is nowhere for a box that lets its content overflow', () => {
    expect(clipArea(style({}), laidOut(box))).toBeUndefined();
  });

  it('is the padding box for overflow hidden', () => {
    expect(clipArea(style({ overflowX: 'hidden', overflowY: 'hidden' }), laidOut(box))).toEqual({ top: 200, right: 400, bottom: 280, left: 100 });
  });

  it('reaches the clip margin past the padding box for paint containment', () => {
    expect(clipArea(style({ contentVisibility: 'auto', overflowClipMargin: '32px' }), laidOut(box))).toEqual({ top: 168, right: 432, bottom: 312, left: 68 });
  });

  it("is all a scroller can scroll to on its scrolling axis, and its padding box across it", () => {
    const scrolled = laidOut(box, { width: 300, height: 1000, left: 0, top: 400 });
    expect(clipArea(style({ overflowX: 'auto', overflowY: 'auto' }), scrolled)).toEqual({ top: -200, right: 400, bottom: 800, left: 100 });
  });
});

describe('shadowClips', () => {
  const bubble = { left: 24, top: 100, width: 300, height: 40 };

  function nested(parentStyle: Partial<CSSStyleDeclaration>, parentRect = bubble) {
    const parent = document.createElement('div');
    const child = document.createElement('div');
    Object.assign(parent.style, parentStyle);
    child.style.boxShadow = SHADOW_REST;
    parent.append(child);
    document.body.append(parent);
    place(parent, parentRect);
    place(child, bubble);
    return child;
  }

  it('fails a parent that clips the bubble at its corners', () => {
    expect(shadowClips(nested({ overflowX: 'hidden', overflowY: 'hidden', borderRadius: '20px' }))).toEqual([
      '<div class=""> cuts its top by 12px',
      '<div class=""> cuts its right by 16px',
      '<div class=""> cuts its bottom by 20px',
      '<div class=""> cuts its left by 16px',
    ]);
  });

  it('passes a parent that leaves room for the whole shadow', () => {
    expect(shadowClips(nested({ overflowX: 'hidden', overflowY: 'hidden' }, { left: 0, top: 80, width: 350, height: 90 }))).toEqual([]);
    expect(shadowClips(nested({}))).toEqual([]);
  });
});
