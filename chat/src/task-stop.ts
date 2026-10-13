import type { TaskStopSleep } from './agent-computer.js';
/** ECS kills a stopping task 120 s after its SIGTERM (stopTimeout, preview-chat-service.ts): a sleep still running by then has failed. */
const STOP_DEADLINE_MS = 110_000;

/** Every failure of the sleep at task stop logs this line, which alarms (ADR 0030). */
const STOP_SLEEP_FAILED = 'Agent Computer sleep at task stop failed';

export function sleepComputersAtTaskStop(sleepAgentComputers: () => TaskStopSleep): void {
      process.once('SIGTERM', () => {
        let exiting = false;
        const exit = (code: number, stream: NodeJS.WriteStream) => {
          if (exiting) return;
          exiting = true;
          clearTimeout(deadline);
          stream.write('', () => process.exit(code));
        };
        const deadline = setTimeout(() => {
          console.error(STOP_SLEEP_FAILED, new Error(`Agent Computers still sleeping ${STOP_DEADLINE_MS} ms after SIGTERM`));
          exit(1, process.stderr);
        }, STOP_DEADLINE_MS).unref();
        const { slept, sleeps } = sleepAgentComputers();
        slept.then(
          (sessions) => {
            if (exiting) return;
            console.log(`Agent Computers slept at task stop: ${sessions.join(', ') || 'none awake'}`);
            exit(0, process.stdout);
          },
          (error: unknown) => {
            if (exiting) return;
            // The first failure alarms at once (ADR 0030), and each later one as it comes: the other browsers go on
            // sleeping before the task exits.
            console.error(STOP_SLEEP_FAILED, error);
            const logged = sleeps.map((sleep) =>
              sleep.catch((later: unknown) => {
                if (later !== error) console.error(STOP_SLEEP_FAILED, later);
              }),
            );
            void Promise.all(logged).then(() => exit(1, process.stderr));
          },
        );
      });
}
