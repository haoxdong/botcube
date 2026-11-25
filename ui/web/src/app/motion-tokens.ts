let read: { quick: number; move: number; ease: string } | undefined;

// --motion-quick and --motion-move in ms and --ease, read once: a read computes the root's style, and nothing changes
// them while the page runs. Unset tokens are instant, and read again until a stylesheet sets them.
export function motion() {
  if (read) return read;
  if (typeof document === "undefined") return { quick: 0, move: 0, ease: "ease" };
  const style = getComputedStyle(document.documentElement);
  const ms = (name: string) => {
    const value = style.getPropertyValue(name).trim();
    const amount = Number.parseFloat(value);
    return Number.isNaN(amount) ? 0 : value.endsWith("ms") ? amount : amount * 1000;
  };
  const tokens = { quick: ms("--motion-quick"), move: ms("--motion-move"), ease: style.getPropertyValue("--ease").trim() || "ease" };
  if (style.getPropertyValue("--motion-move").trim() !== "") read = tokens;
  return tokens;
}

/** For tests that restyle the tokens. */
export function forgetMotion() {
  read = undefined;
}

/** The tokens as Motion springs, at the CSS reference's pace without overshoot. */
export function motionTokens() {
  const spring = (ms: number) => ({ type: "spring" as const, visualDuration: ms / 2000, bounce: 0, ...(ms === 0 ? { duration: 0 } : {}) });
  const { move, quick } = motion();
  return { move: spring(move), quick: spring(quick) };
}
