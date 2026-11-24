import { useSyncExternalStore } from 'react';

const REST = { inset: 0, top: 0 };
let snapshot: typeof REST | undefined;

function measure() {
  const viewport = window.visualViewport;
  const top = viewport?.scale === 1 ? Math.max(0, viewport.offsetTop) : 0;
  const inset = viewport?.scale === 1 ? Math.max(0, window.innerHeight - viewport.height - top) : 0;
  if (snapshot?.inset !== inset || snapshot.top !== top) snapshot = { inset, top };
  return snapshot;
}

// Measures on the viewport's own events, never on a store read: a read right after React's commit forces layout.
function subscribe(onChange: () => void) {
  const viewport = window.visualViewport;
  const update = () => (measure(), onChange());
  measure();
  window.addEventListener('resize', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  return () => {
    window.removeEventListener('resize', update);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
  };
}

// Safari leaves the layout viewport full-height above a software keyboard and ignores interactive-widget.
export function usePhoneViewport() {
  return useSyncExternalStore(subscribe, () => snapshot ?? measure(), () => REST);
}
