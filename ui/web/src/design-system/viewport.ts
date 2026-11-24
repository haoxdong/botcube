// The viewport (ADR 0094): the app decides phone, tablet or desktop here, once. Every stylesheet's phone breakpoint is
// PHONE_QUERY or DESKTOP_QUERY, written out; the one-source check fails any other three-digit width query and any width
// asked of matchMedia outside this file. A layout's own wider widths (the Agent Profile's, the shell's, the plugins') are
// not the phone breakpoint, and keep their four-digit queries.
import { useSyncExternalStore } from 'react';

/** The widest phone, in CSS px: at or below it the app is laid out as a phone. */
export const PHONE_MAX_WIDTH = 640;
/** A phone: the stylesheets' `@media (max-width: 640px)`. */
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
/** Wider than a phone: the stylesheets' `@media (min-width: 641px)`. */
const DESKTOP_QUERY = `(min-width: ${PHONE_MAX_WIDTH + 1}px)`;
/** Wider than a phone and touched, not pointed at: an iPad. It keeps the desktop layout. */
const TABLET_QUERY = `${DESKTOP_QUERY} and (hover: none) and (pointer: coarse)`;

export type Viewport = 'phone' | 'tablet' | 'desktop';

/** The viewport now; a server render is a desktop. */
export function viewport(): Viewport {
  if (typeof window === 'undefined') return 'desktop';
  if (window.matchMedia(PHONE_QUERY).matches) return 'phone';
  return window.matchMedia(TABLET_QUERY).matches ? 'tablet' : 'desktop';
}

const subscribe = (onChange: () => void) => {
  const queries = [PHONE_QUERY, TABLET_QUERY].map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener('change', onChange);
  return () => {
    for (const query of queries) query.removeEventListener('change', onChange);
  };
};

/** The viewport, following resizes and rotations; a server render is a desktop. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, viewport, () => 'desktop');
}
