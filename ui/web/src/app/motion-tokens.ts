function seconds(style: CSSStyleDeclaration, name: string): number {
  const value = style.getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith("ms") ? amount / 1000 : amount;
}

function spring(referenceDuration: number) {
  const visualDuration = referenceDuration / 2;
  return { type: "spring" as const, visualDuration, bounce: 0, ...(visualDuration === 0 ? { duration: 0 } : {}) };
}

export function motionTokens() {
  if (typeof document === "undefined") return { move: spring(0), quick: spring(0) };
  const style = getComputedStyle(document.documentElement);
  return {
    move: spring(seconds(style, "--motion-move")),
    quick: spring(seconds(style, "--motion-quick")),
  };
}

// A spring chasing a target that moves mid-flight sank below it or, restarted from rest, lagged and snapped; this tween does neither.
export function moveTween() {
  if (typeof document === "undefined") return { duration: 0 };
  const style = getComputedStyle(document.documentElement);
  const curve = /cubic-bezier\(([^)]*)\)/.exec(style.getPropertyValue("--ease"))?.[1]?.split(",").map(Number);
  return { duration: seconds(style, "--motion-move"), ...(curve?.length === 4 ? { ease: curve as [number, number, number, number] } : {}) };
}
