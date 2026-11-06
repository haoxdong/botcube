/** AgentCore refuses a starting Session's second invocation (SESSION_BUSY), so a Turn awaits the Session's warmup. */
export function warmingSessions() {
  const warming = new Map<string, Promise<void>>();
  const key = (owner: string, sessionId: string) => JSON.stringify([owner, sessionId]);
  return {
    until: (owner: string, sessionId: string, timeoutMs: number) =>
      Promise.race([warming.get(key(owner, sessionId)), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]),
    begin(owner: string, sessionId: string): () => void {
      let release = () => {};
      const settled = new Promise<void>((resolve) => { release = resolve; });
      warming.set(key(owner, sessionId), settled);
      void settled.then(() => {
        if (warming.get(key(owner, sessionId)) === settled) warming.delete(key(owner, sessionId));
      });
      return release;
    },
  };
}

/** A warmup's `chat_warmup_timing` line: each stage's first offset from receipt, so a slow warmup shows whether Chat's own
 * work or AgentCore starting the Session took the time. */
export function warmupTiming(receipt = performance.now()) {
  const chatMs: Record<string, number> = {};
  const mark = (stage: string) => { chatMs[stage] ??= Math.round((performance.now() - receipt) * 10) / 10; };
  return {
    mark,
    log(sessionId: string, outcome: string) {
      mark('end');
      console.info(JSON.stringify({ event: 'chat_warmup_timing', sessionId, outcome, chatMs }));
    },
  };
}
