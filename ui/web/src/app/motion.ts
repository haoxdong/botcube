/** --motion-move in ms, as the page resolves it; 300 where no stylesheet sets it. */
export function moveMs() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-move").trim();
  const amount = Number.parseFloat(value);
  return Number.isNaN(amount) ? 300 : value.endsWith("ms") ? amount : amount * 1000;
}
