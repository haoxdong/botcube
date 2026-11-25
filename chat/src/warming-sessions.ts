import { setTimeout as delay } from 'node:timers/promises';

interface Warmup<T> {
  agent: Promise<void>;
  answer: Promise<T>;
}

/** A Turn waits for its Session's Runtime warmups, independent of the bot's warmup. */
export function warmingSessions<T>() {
  const sessions = new Map<string, Map<string, Warmup<T>>>();
  const key = (owner: string, sessionId: string) => JSON.stringify([owner, sessionId]);
  return {
    async until(owner: string, sessionId: string, timeoutMs: number) {
      const active = sessions.get(key(owner, sessionId));
      if (active === undefined) return;
      const timeout = new AbortController();
      try {
        await Promise.race([
          Promise.allSettled([...active.values()].map(({ agent }) => agent)),
          delay(timeoutMs, undefined, { signal: timeout.signal, ref: false }),
        ]);
      } finally {
        timeout.abort();
      }
    },
    run(owner: string, sessionId: string, options: string, start: () => Warmup<T>) {
      const session = key(owner, sessionId);
      const active = sessions.get(session) ?? new Map<string, Warmup<T>>();
      const existing = active.get(options);
      if (existing) return existing.answer;
      const warmup = start();
      active.set(options, warmup);
      sessions.set(session, active);
      void Promise.allSettled([warmup.agent, warmup.answer]).then(() => {
        active.delete(options);
        if (active.size === 0) sessions.delete(session);
      });
      return warmup.answer;
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
