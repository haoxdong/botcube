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

/** --motion-move in ms, as the page resolves it; 300 where no stylesheet sets it. */
export function moveMs() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-move").trim();
  const amount = Number.parseFloat(value);
  return Number.isNaN(amount) ? 300 : value.endsWith("ms") ? amount : amount * 1000;
}
