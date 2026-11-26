// Windows 11 snapping: the zones a window snaps to, and where a drag drops it.

/** Where a snapped window sits, as fractions of the screen above the taskbar: x, y, width, height. */
const ZONES = {
  max: [0, 0, 1, 1],
  left: [0, 0, 1 / 2, 1],
  right: [1 / 2, 0, 1 / 2, 1],
  'top-left': [0, 0, 1 / 2, 1 / 2],
  'top-right': [1 / 2, 0, 1 / 2, 1 / 2],
  'bottom-left': [0, 1 / 2, 1 / 2, 1 / 2],
  'bottom-right': [1 / 2, 1 / 2, 1 / 2, 1 / 2],
} as const;

export type Zone = keyof typeof ZONES;

export interface Area { width: number; height: number }
export interface Place { x: number; y: number; width: number; height: number }

export function zoneRect(zone: Zone, { width, height }: Area): Place {
  const [x, y, w, h] = ZONES[zone];
  return { x: Math.round(x * width), y: Math.round(y * height), width: Math.round(w * width), height: Math.round(h * height) };
}

/**
 * Where a window dropped with the pointer at the screen's edges snaps, as Windows decides by the cursor: a side to its
 * half, a corner to its quarter, the top to the whole screen. The pointer is in the screen's own pixels.
 */
export function dropZone({ x, y }: { x: number; y: number }, area: Area): Zone | null {
  const left = x <= 1;
  const right = x >= area.width - 1;
  const top = y <= 1;
  const bottom = y >= area.height - 1;
  if (left || right) {
    const side = left ? 'left' : 'right';
    return top ? `top-${side}` : bottom ? `bottom-${side}` : side;
  }
  return top ? 'max' : null;
}
