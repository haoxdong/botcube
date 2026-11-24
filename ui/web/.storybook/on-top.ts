// Whether a box lies over everything at its place, for the layer tokens: a menu opens over any sheet or panel.

/** The points of `element`'s box, its middle and just inside each corner, where something else wins the hit test. */
export function coveredPoints(element: Element): [number, number][] {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  // Inside a 8px corner's curve, so the hit test lands on the box and not past its rounding.
  const inset = 4;
  const points: [number, number][] = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + inset, top + inset],
    [right - inset, top + inset],
    [left + inset, bottom - inset],
    [right - inset, bottom - inset],
  ];
  return points.filter(([x, y]) => !element.contains(element.ownerDocument.elementFromPoint(x, y)));
}
