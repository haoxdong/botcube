// The list's area in a File Explorer tab: where files drop to upload, arrows move the selection, and Ctrl+wheel steps
// the view, around the items (ADR 0093).
import { makeStyles, mergeClasses, tokens, useMergedRefs } from '@fluentui/react-components';
import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode, type Ref } from 'react';

const useStyles = makeStyles({
  list: { position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' },
  dropping: {
    outlineWidth: tokens.strokeWidthThick,
    outlineStyle: 'dashed',
    outlineColor: tokens.colorBrandStroke1,
    outlineOffset: `calc(-1 * ${tokens.strokeWidthThick})`,
  },
});

/** How an arrow key moved focus: with Ctrl (or Cmd) it moves focus alone, with Shift it selects the range. */
export type Arrowed = { toggle: boolean; range: boolean };

/**
 * The list's area. Files dragged in from the computer drop to upload; an arrow key that moves focus to an item moves
 * the selection with it; Ctrl+wheel steps the view, toward larger icons as it rolls up, as Windows does. Other props,
 * such as a menu trigger's, go to the area itself.
 */
export function ListArea({ ref, areaRef, onDropFiles, onArrowed, onStep, className, children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  ref?: Ref<HTMLDivElement>;
  areaRef: { current: HTMLDivElement | null };
  onDropFiles: (files: FileList) => void;
  /** An item took focus from an arrow key. */
  onArrowed: (path: string, arrowed: Arrowed) => void;
  /** Ctrl+wheel: -1 toward larger icons, 1 toward Details and Content. */
  onStep: (by: -1 | 1) => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const [dropping, setDropping] = useState(false);
  const arrowed = useRef<Arrowed | null>(null);
  const dragsFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  // Ctrl+wheel would zoom the page: the area listens for itself, not passively, to keep the wheel for the view.
  const element = useRef<HTMLDivElement | null>(null);
  const refs = useMergedRefs(ref, areaRef, element);
  const step = useRef(onStep);
  step.current = onStep;
  useEffect(() => {
    const area = element.current;
    if (area === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      step.current(event.deltaY < 0 ? -1 : 1);
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div
      {...props}
      ref={refs}
      className={mergeClasses('agent-computer-files-list', styles.list, dropping && styles.dropping, className)}
      onKeyDownCapture={(event) => {
        arrowed.current = event.key.startsWith('Arrow') && !event.altKey ? { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey } : null;
      }}
      onPointerDown={() => { arrowed.current = null; }}
      onFocus={(event) => {
        // An arrow moves the selection with focus; Ctrl+arrow moves focus alone, Shift+arrow selects the range.
        const moved = arrowed.current;
        const path = event.target instanceof HTMLElement ? event.target.dataset.filePath : undefined;
        arrowed.current = null;
        if (moved === null || path === undefined || (moved.toggle && !moved.range)) return;
        onArrowed(path, moved);
      }}
      onDragOver={(event) => {
        if (!dragsFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropping(false); }}
      onDrop={(event) => {
        if (!dragsFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        onDropFiles(event.dataTransfer.files);
      }}
    >
      {children}
    </div>
  );
}
