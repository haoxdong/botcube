/**
 * A replaced Chat Service task drains for up to the target group's one-hour deregistration delay, finishing its
 * requests and Turns. Its background sweeps over shared state stop then, so only the new revision's rules act.
 */
export async function stillServing(draining: () => Promise<boolean>): Promise<boolean> {
  try {
    if (!await draining()) return true;
    console.log('This Chat Service task is draining; its background sweeps stop');
    return false;
  } catch (error) {
    console.error('Cannot tell whether this Chat Service task is draining; its background sweeps go on', error);
    return true;
  }
}

/** Run `sweep` every `everyMs` after the previous run ends, until the task drains or the returned stop is called. */
export function sweepEvery(everyMs: number, draining: () => Promise<boolean>, sweep: () => Promise<void>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const next = () => { if (!stopped) timer = setTimeout(() => { void tick(); }, everyMs).unref(); };
  const tick = async () => {
    if (!await stillServing(draining)) return;
    await sweep().catch((error: unknown) => console.error('Background sweep failed', error));
    next();
  };
  next();
  return () => { stopped = true; clearTimeout(timer); };
}
