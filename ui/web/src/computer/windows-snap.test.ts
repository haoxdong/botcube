import { describe, expect, it } from 'vitest';

import { dropZone, zoneRect } from './windows-snap';

const AREA = { width: 1280, height: 672 };

describe('snap zones', () => {
  it('lays each zone out on the screen above the taskbar', () => {
    expect(zoneRect('max', AREA)).toEqual({ x: 0, y: 0, width: 1280, height: 672 });
    expect(zoneRect('right', AREA)).toEqual({ x: 640, y: 0, width: 640, height: 672 });
    expect(zoneRect('bottom-left', AREA)).toEqual({ x: 0, y: 336, width: 640, height: 336 });
  });

  it('snaps by where the pointer lets go: a side to its half, a corner to its quarter, the top to the whole screen', () => {
    const at = (x: number, y: number) => dropZone({ x, y }, AREA);
    expect(at(0, 336)).toBe('left');
    expect(at(-40, 336)).toBe('left');
    expect(at(1280, 336)).toBe('right');
    expect(at(0, 0)).toBe('top-left');
    expect(at(1300, 700)).toBe('bottom-right');
    expect(at(640, 0)).toBe('max');
    expect(at(640, 336)).toBeNull();
    // A window pushed against an edge with the pointer away from it stays where it is dropped.
    expect(at(120, 371)).toBeNull();
  });
});
