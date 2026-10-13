import { useLayoutEffect, type RefObject } from 'react';

const LAYOUT = '.copilotKitInput > [data-layout]';

/** The text box's height for its draft, up to the cap CopilotKit sets, as CopilotKit sizes it. */
function resize(layout: Node) {
  if (!(layout instanceof Element) || !layout.matches(LAYOUT)) return;
  const textarea = layout.querySelector('textarea');
  if (textarea === null) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, parseFloat(textarea.style.maxHeight) || Infinity)}px`;
}

/**
 * CopilotKit sizes the composer's text box to its draft, then lays a desktop's composer out `expanded` once the draft
 * outgrows the compact text column, and skips sizing it in the new layout: a line that wrapped in the compact column
 * kept two lines' height across the expanded one. Each change of layout under `root` sizes it again.
 */
export function useComposerResizesOnLayout(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    const observer = new MutationObserver((records) => records.forEach(({ target }) => resize(target)));
    observer.observe(element, { attributes: true, attributeFilter: ['data-layout'], subtree: true });
    return () => observer.disconnect();
  }, [root]);
}
