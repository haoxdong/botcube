export function idlePreload(load: () => Promise<unknown>): () => () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return () => {};
    scheduled = true;
    const run = () => void load();
    if (typeof requestIdleCallback === "function") {
      const idle = requestIdleCallback(run, { timeout: 2000 });
      return () => cancelIdleCallback(idle);
    }
    const timer = setTimeout(run, 1000);
    return () => clearTimeout(timer);
  };
}
