// File Explorer's pane dividers, which drag or take the arrow keys to resize a pane, from a stock Fluent Divider and
// fluentui-contrib's resize handle (ADR 0093).
import { useResizeHandle } from '@fluentui-contrib/react-resize-handle';
import { Divider, makeStyles, mergeClasses } from '@fluentui/react-components';

const useStyles = makeStyles({
  handle: { flexGrow: 0, flexShrink: 0, alignSelf: 'stretch', cursor: 'col-resize', touchAction: 'none' },
});

/**
 * A pane's size and the divider that changes it: drag the divider, or focus it and press Left or Right. The size is the
 * pane's CSS variable, set on the pane itself and kept between `min` and `max` pixels.
 */
export function usePaneSize({ variable, grow, min, max }: { variable: string; grow: 'start' | 'end'; min: number; max: number }) {
  const { elementRef, handleRef } = useResizeHandle({ variableName: variable, variableTarget: 'element', growDirection: grow, minValue: min, maxValue: max });
  return { elementRef, handleRef };
}

/** The divider a pane is resized by: Fluent's vertical divider, named for the pane, which the arrow keys move. */
export function PaneDivider({ label, handleRef, className }: { label: string; handleRef: (node: HTMLElement | null) => void; className?: string }) {
  const styles = useStyles();
  return <Divider vertical ref={handleRef} tabIndex={0} aria-label={label} className={mergeClasses(styles.handle, className)} />;
}
