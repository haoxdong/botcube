import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * `element`'s CSS zoom, the wide desktop's `--ui-zoom`: a rect on screen is in the screen's pixels, a scroll and an offset
 * inside the zoomed app in the box's own, `zoom` times fewer. 1 in a browser without `currentCSSZoom`.
 */
export function zoomOf(element: Element | null): number {
  return element?.currentCSSZoom ?? 1
}
