/** A token's duration in seconds; 0 where no stylesheet sets it, so nothing waits on a transition that never runs. */
function seconds(style: CSSStyleDeclaration, name: string): number {
  const value = style.getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith("ms") ? amount / 1000 : amount;
}

/**
 * The motion tokens (globals.css :root, DESIGN.md Motion) as Motion transitions: `move` for what travels or changes
 * size, `quick` for what fades in place.
 */
export function motionTokens() {
  if (typeof document === "undefined") return { move: { duration: 0 }, quick: { duration: 0 } };
  const style = getComputedStyle(document.documentElement);
  const curve = /cubic-bezier\(([^)]*)\)/.exec(style.getPropertyValue("--ease"))?.[1]?.split(",").map(Number);
  const ease = curve?.length === 4 ? (curve as [number, number, number, number]) : undefined;
  return {
    move: { duration: seconds(style, "--motion-move"), ...(ease ? { ease } : {}) },
    quick: { duration: seconds(style, "--motion-quick"), ...(ease ? { ease } : {}) },
  };
}
