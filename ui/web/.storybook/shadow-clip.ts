type Edges = { top: number; right: number; bottom: number; left: number };
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export function shadowReach(boxShadow: string): Edges {
  const reach = { top: 0, right: 0, bottom: 0, left: 0 };
  if (boxShadow === 'none') return reach;
  for (const shadow of boxShadow.split(/,(?![^(]*\))/)) {
    if (/\binset\b/.test(shadow)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.replace(/[\w-]+\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    reach.top = Math.max(reach.top, blur + spread - y);
    reach.right = Math.max(reach.right, blur + spread + x);
    reach.bottom = Math.max(reach.bottom, blur + spread + y);
    reach.left = Math.max(reach.left, blur + spread - x);
  }
  return reach;
}

export type ClipStyle = Pick<CSSStyleDeclaration, 'overflowX' | 'overflowY' | 'contain' | 'contentVisibility' | 'overflowClipMargin'>;
export type Layout = Pick<
  Element,
  'getBoundingClientRect' | 'clientLeft' | 'clientTop' | 'clientWidth' | 'clientHeight' | 'scrollLeft' | 'scrollTop' | 'scrollWidth' | 'scrollHeight'
>;

// Paint containment and `overflow: clip` reach `overflow-clip-margin` past the padding box (CSS Overflow 4).
export function clipArea(style: ClipStyle, box: Layout): Edges | undefined {
  const border = box.getBoundingClientRect();
  const left = border.left + box.clientLeft;
  const top = border.top + box.clientTop;
  const padding = { top, right: left + box.clientWidth, bottom: top + box.clientHeight, left };
  const margin = parseFloat(style.overflowClipMargin) || 0;
  const contained = /\b(paint|strict|content)\b/.test(style.contain) || style.contentVisibility === 'auto';
  const axis = (overflow: string, start: 'left' | 'top', end: 'right' | 'bottom', scrolled: number, size: number, client: number) => {
    if ((overflow === 'auto' || overflow === 'scroll') && size > client) return [padding[start] - scrolled, padding[start] - scrolled + size];
    if (overflow === 'hidden' || overflow === 'auto' || overflow === 'scroll') return [padding[start], padding[end]];
    if (overflow === 'clip' || contained) return [padding[start] - margin, padding[end] + margin];
    return [-Infinity, Infinity];
  };
  const [areaLeft = 0, areaRight = 0] = axis(style.overflowX, 'left', 'right', box.scrollLeft, box.scrollWidth, box.clientWidth);
  const [areaTop = 0, areaBottom = 0] = axis(style.overflowY, 'top', 'bottom', box.scrollTop, box.scrollHeight, box.clientHeight);
  if ([areaLeft, areaTop].every((edge) => edge === -Infinity)) return undefined;
  return { top: areaTop, right: areaRight, bottom: areaBottom, left: areaLeft };
}

export function shadowClips(element: Element): string[] {
  const style = getComputedStyle(element);
  const reach = shadowReach(style.boxShadow);
  const box = element.getBoundingClientRect();
  const shadow = { top: box.top - reach.top, right: box.right + reach.right, bottom: box.bottom + reach.bottom, left: box.left - reach.left };
  const clips: string[] = [];
  for (let ancestor = element.parentElement; ancestor && ancestor !== element.ownerDocument.documentElement; ancestor = ancestor.parentElement) {
    const area = clipArea(getComputedStyle(ancestor), ancestor);
    if (!area) continue;
    const cut = {
      top: area.top - shadow.top,
      right: shadow.right - area.right,
      bottom: shadow.bottom - area.bottom,
      left: area.left - shadow.left,
    };
    for (const side of SIDES)
      if (cut[side] > 0.5) clips.push(`<${ancestor.tagName.toLowerCase()} class="${ancestor.className}"> cuts its ${side} by ${Math.round(cut[side])}px`);
  }
  return clips;
}
