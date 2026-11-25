import { chatAlarmEvents } from 'botcube-config/alarm-events';

// ECS gives the stopping task 120 s. The Turn drain leaves time for a separate tracing flush.
const SLEEP_DEADLINE_MS = 110_000;
const TURN_DRAIN_DEADLINE_MS = 105_000;
const TRACING_DEADLINE_MS = 10_000;

/** What putting every awake Agent Computer to sleep at task stop answers. */
export interface TaskStopSleep {
  /** The browser Sessions put to sleep, or the first failure (ADR 0030). */
  slept: Promise<readonly string[]>;
  /** Every sleep and stop at task stop, each settling on its own. */
  sleeps: readonly Promise<void>[];
}

async function beforeDeadline<T>(work: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function finishChatWork(drain: () => Promise<void>, flushTracing?: () => Promise<void>): Promise<void> {
  await beforeDeadline(drain, TURN_DRAIN_DEADLINE_MS, 'Chat Turn drain').catch((error: unknown) => {
    console.error('Chat Turn drain failed', error);
  });
  if (flushTracing !== undefined) {
    await beforeDeadline(flushTracing, TRACING_DEADLINE_MS, 'Chat tracing shutdown').catch((error: unknown) => {
      console.error('Chat tracing shutdown failed', error);
    });
  }
}

async function sleepComputers(sleep: () => TaskStopSleep): Promise<number> {
  let collecting = true;
  const alarm = (error: unknown) => {
    if (collecting) console.error(chatAlarmEvents.agentComputerStopSleepFailed, error);
  };
  try {
    const sessions = await beforeDeadline(async () => {
      const { slept, sleeps } = sleep();
      try {
        return await slept;
      } catch (first) {
        alarm(first);
        await Promise.all(sleeps.map((operation) => operation.catch((later: unknown) => {
          if (later !== first) alarm(later);
        })));
        return null;
      }
    }, SLEEP_DEADLINE_MS, 'Agent Computer sleep at task stop');
    if (sessions === null) return 1;
    console.log(`Agent Computers slept at task stop: ${sessions.join(', ') || 'none awake'}`);
    return 0;
  } catch (error) {
    alarm(error);
    return 1;
  } finally {
    collecting = false;
  }
}

/** On SIGTERM or SIGINT, run bounded shutdown work and exit with the Agent Computer sleep result. */
export function sleepComputersAtTaskStop(sleep: () => TaskStopSleep, finish?: () => Promise<void>): () => void {
  const stop = () => {
    unregister();
    void Promise.all([sleepComputers(sleep), finish?.()]).then(async ([code]) => {
      await Promise.all([process.stdout, process.stderr].map((stream) =>
        new Promise<void>((resolve) => { stream.write('', () => resolve()); }),
      ));
      process.exit(code);
    });
  };
  const unregister = () => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return unregister;
}
