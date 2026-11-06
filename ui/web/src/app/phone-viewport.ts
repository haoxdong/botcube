import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  const viewport = window.visualViewport;
  window.addEventListener('resize', onChange);
  viewport?.addEventListener('resize', onChange);
  viewport?.addEventListener('scroll', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    viewport?.removeEventListener('resize', onChange);
    viewport?.removeEventListener('scroll', onChange);
  };
}

const REST = { inset: 0, top: 0 };
let snapshot = REST;

function visibleViewport() {
  const viewport = window.visualViewport;
  const top = viewport?.scale === 1 ? Math.max(0, viewport.offsetTop) : 0;
  const inset = viewport?.scale === 1 ? Math.max(0, window.innerHeight - viewport.height - top) : 0;
  if (snapshot.inset !== inset || snapshot.top !== top) snapshot = { inset, top };
  return snapshot;
}

// Safari leaves the layout viewport full-height above a software keyboard and ignores interactive-widget.
export function usePhoneViewport() {
  return useSyncExternalStore(subscribe, visibleViewport, () => REST);
}
