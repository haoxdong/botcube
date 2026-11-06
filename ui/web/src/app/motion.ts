import { flushSync } from "react-dom";

/** --motion-move in ms, as the page resolves it; 300 where no stylesheet sets it. */
export function moveMs() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-move").trim();
  const amount = Number.parseFloat(value);
  return Number.isNaN(amount) ? 300 : value.endsWith("ms") ? amount : amount * 1000;
}

/**
 * Glides `element`'s `size` from its last value to its current one over --motion-move with --ease (DESIGN.md Motion).
 * A glide during one carries on from where that one is: where it started, while it is
 * still pending, as layout doesn't show it until its first frame.
 */
export function sizeGlide(element: HTMLElement, size: "width" | "height", frame: Keyframe = {}) {
  let last = element.getBoundingClientRect()[size];
  let running: Animation | null = null;
  let start = last;
  return {
    /** `align` overrides `frame` for this glide only. */
    glide(align: Keyframe = {}) {
      const from = running === null ? last : running.pending ? start : element.getBoundingClientRect()[size];
      running?.cancel();
      running = null;
      const to = element.getBoundingClientRect()[size];
      last = to;
      const duration = moveMs();
      if (Math.abs(to - from) < 1) return;
      const ease = getComputedStyle(document.documentElement).getPropertyValue("--ease").trim();
      const animation = element.animate([{ ...frame, ...align, [size]: `${from}px` }, { ...frame, ...align, [size]: `${to}px` }], { duration, easing: ease || "ease" });
      running = animation;
      start = from;
      animation.finished.catch(() => undefined);
      animation.onfinish = () => { if (running === animation) running = null; };
    },
    stop() { running?.cancel(); },
  };
}

/**
 * Runs `change` as a View Transition, so what it resizes or moves glides into place (globals.css's
 * `::view-transition-*`, DESIGN.md Motion); at once where the browser has none.
 */
export function glide(change: () => void) {
  if (typeof document.startViewTransition !== "function") {
    change();
    return;
  }
  // Names give what glides a stacking context, which would hold a sheet inside it under the sidebar: they apply only
  // while a glide runs (`[data-glide]`, motion.css), counted, as a toggle may start one while another runs.
  const root = document.documentElement;
  root.dataset.glide = String(Number(root.dataset.glide ?? 0) + 1);
  const transition = document.startViewTransition(() => flushSync(change));
  // A toggle while one glides skips the first, rejecting its `ready`; the change itself has still happened.
  transition.ready.catch(() => undefined);
  // WebKit can leave a transition running once its animations end, and while one runs no tap reaches the page: past
  // its time, with room for a loaded frame, it is skipped.
  const stuck = setTimeout(() => transition.skipTransition(), moveMs() + 500);
  void transition.finished.finally(() => {
    clearTimeout(stuck);
    const left = Number(root.dataset.glide) - 1;
    if (left > 0) root.dataset.glide = String(left);
    else delete root.dataset.glide;
  });
}
