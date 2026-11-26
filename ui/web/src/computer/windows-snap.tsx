// Windows 11 snapping: the zones a window snaps to, where a drag drops it, and the Snap layouts flyout on Maximise.
import { Button, makeStyles, Popover, PopoverSurface, PopoverTrigger, tokens, useTimeout } from '@fluentui/react-components';
import { useState, type ReactElement } from 'react';

/** Where a snapped window sits, as fractions of the screen above the taskbar: x, y, width, height. */
const ZONES = {
  max: [0, 0, 1, 1],
  left: [0, 0, 1 / 2, 1],
  right: [1 / 2, 0, 1 / 2, 1],
  'top-left': [0, 0, 1 / 2, 1 / 2],
  'top-right': [1 / 2, 0, 1 / 2, 1 / 2],
  'bottom-left': [0, 1 / 2, 1 / 2, 1 / 2],
  'bottom-right': [1 / 2, 1 / 2, 1 / 2, 1 / 2],
  'left-two-thirds': [0, 0, 2 / 3, 1],
  'right-third': [2 / 3, 0, 1 / 3, 1],
} as const;

export type Zone = keyof typeof ZONES;

const LABELS: Record<Zone, string> = {
  max: 'Maximise',
  left: 'Left half',
  right: 'Right half',
  'top-left': 'Top left quarter',
  'top-right': 'Top right quarter',
  'bottom-left': 'Bottom left quarter',
  'bottom-right': 'Bottom right quarter',
  'left-two-thirds': 'Left two thirds',
  'right-third': 'Right third',
};

/**
 * Windows 11's snap layouts for a screen that is not large, each drawn as its zones on a grid. Three windows side by
 * side come only on large landscape screens, and the computer's screen is 1280x720.
 */
const LAYOUTS: readonly { name: string; columns: string; areas: string; zones: readonly Zone[] }[] = [
  { name: 'Halves', columns: '1fr 1fr', areas: '"left right"', zones: ['left', 'right'] },
  { name: 'Two thirds and a third', columns: '2fr 1fr', areas: '"left-two-thirds right-third"', zones: ['left-two-thirds', 'right-third'] },
  { name: 'A half and two quarters', columns: '1fr 1fr', areas: '"left top-right" "left bottom-right"', zones: ['left', 'top-right', 'bottom-right'] },
  { name: 'Quarters', columns: '1fr 1fr', areas: '"top-left top-right" "bottom-left bottom-right"', zones: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] },
];

/** Windows 11 waits this long on Maximise before it offers the layouts. */
export const SNAP_LAYOUTS_DELAY = 400;

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

const useStyles = makeStyles({
  layouts: { display: 'grid', gridTemplateColumns: 'repeat(2, 104px)', gap: tokens.spacingHorizontalM },
  layout: { display: 'grid', height: '64px', gap: tokens.spacingHorizontalXXS },
  // Grey zones that fill with the accent under the pointer, as Windows 11's own.
  zone: {
    minWidth: 0,
    width: '100%',
    height: '100%',
    padding: 0,
    backgroundColor: tokens.colorNeutralBackground3,
    ':hover': { backgroundColor: tokens.colorBrandBackground },
    ':hover:active': { backgroundColor: tokens.colorBrandBackgroundPressed },
  },
});

/**
 * The Maximise caption button: hovered a moment, it offers Windows' snap layouts; each zone snaps the window there.
 * `enabled` false (a phone) keeps it a plain button.
 */
export function SnapLayouts({ app, label, icon, enabled, mountNode, onMaximise, onSnap }: { app: string; label: string; icon: ReactElement; enabled: boolean; mountNode: HTMLElement | null; onMaximise: () => void; onSnap: (zone: Zone) => void }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  // Fluent's own timer, as its Popover waits out a mouse leave; it is cleared on unmount.
  const [wait, cancel] = useTimeout();
  const hover = () => {
    if (enabled) wait(() => setOpen(true), SNAP_LAYOUTS_DELAY);
  };
  const close = () => {
    cancel();
    setOpen(false);
  };
  return (
    // Fluent opens a hovered Popover at once; this one opens only after the wait, so its own open requests are dropped.
    <Popover open={open} openOnHover positioning="below-end" mountNode={mountNode} unstable_disableAutoFocus onOpenChange={(_, data) => { if (!data.open) close(); }}>
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="subtle" aria-label={label} icon={icon} onMouseEnter={hover} onMouseLeave={() => { if (!open) cancel(); }} onClick={() => { close(); onMaximise(); }} />
      </PopoverTrigger>
      <PopoverSurface aria-label={`Snap layouts for ${app}`}>
        <div className={styles.layouts}>
          {LAYOUTS.map((layout) => (
            <div key={layout.name} role="group" aria-label={layout.name} className={styles.layout} style={{ gridTemplateColumns: layout.columns, gridTemplateAreas: layout.areas }}>
              {layout.zones.map((zone) => (
                <Button key={zone} className={styles.zone} style={{ gridArea: zone }} aria-label={LABELS[zone]} onClick={() => { close(); onSnap(zone); }} />
              ))}
            </div>
          ))}
        </div>
      </PopoverSurface>
    </Popover>
  );
}
