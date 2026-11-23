export function idlePreload(load: () => Promise<unknown>): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    const run = () => void load();
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 1000);
  };
}
