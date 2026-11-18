import { flushSync } from "react-dom";

/** --motion-move in ms, as the page resolves it; 300 where no stylesheet sets it. */
export function moveMs() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-move").trim();
  const amount = Number.parseFloat(value);
  return Number.isNaN(amount) ? 300 : value.endsWith("ms") ? amount : amount * 1000;
}

// Motion also waits for native View Transition completion; WebKit can stall it and block taps without a timed skip.
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
  const stuck = setTimeout(() => transition.skipTransition(), moveMs() + 500);
  void transition.finished.finally(() => {
    clearTimeout(stuck);
    const left = Number(root.dataset.glide) - 1;
    if (left > 0) root.dataset.glide = String(left);
    else delete root.dataset.glide;
  });
}
