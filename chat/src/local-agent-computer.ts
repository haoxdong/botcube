import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { HttpError, type AccountHistory, type Requester } from './cartridge.js';
import { agentComputerCdp } from './agent-computer-cdp.js';
import { agentComputerIdleSeconds } from './agent-computer.js';
import { agentComputerTokens } from './agent-computer-token.js';
import { ComputerStartupCancelled, findChromium, startLocalChromium, type LocalChromium } from './local-chromium.js';
import { onThisTask } from './task-address.js';

interface RunningComputer {
  readonly owner: string;
  readonly threadId: string;
  readonly browserSessionId: string;
  readonly ready: Promise<LocalChromium>;
  readonly startup: AbortController;
  failure?: HttpError;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** A local computer's state: it has no Take-over and keeps no screenshot. */
type LocalComputerState =
  | { state: 'awake'; browserSessionId: string; control: 'agent'; screenshot: null }
  | { state: 'asleep'; screenshot: null };

const ASLEEP: LocalComputerState = { state: 'asleep', screenshot: null };

/**
 * BotCube's default Agent Computer, for a Cartridge with no AgentCore browser: each Session
 * gets its own headless Chromium on this Chat Service's host, opened on `startPage`, with a
 * private profile deleted when it sleeps. The agent reaches it through the same tokened,
 * filtered CDP channel as an AgentCore Agent Computer. It runs the Chromium `findChromium`
 * finds, looked up at each start; BOTCUBE_AGENT_COMPUTER_CDP_URL is where the Harness reaches this Chat Service's
 * `/agent-computer/cdp` when not on 127.0.0.1:$PORT.
 */
export function localAgentComputer({
  history,
  requester,
  env,
  startPage = 'about:blank',
}: {
  history: Pick<AccountHistory, 'owns' | 'ownsMainChat'>;
  requester: (c: Context) => Promise<Requester>;
  env: NodeJS.ProcessEnv;
  startPage?: string | undefined;
}) {
  const cdpUrl = new URL(
    env.BOTCUBE_AGENT_COMPUTER_CDP_URL?.trim() || `ws://127.0.0.1:${env.PORT || '8123'}/agent-computer/cdp`
  ).href;
  const startUrl = new URL(startPage).href;
  const idleMs = agentComputerIdleSeconds(env) * 1000;
  const tokens = agentComputerTokens();
  /** The CDP URL on this ECS task's own address, looked up once it is first needed. */
  let taskCdpUrl: Promise<string> | undefined;
  const ownCdpUrl = () =>
    (taskCdpUrl ??= onThisTask(cdpUrl, env).then(
      (url) => url ?? cdpUrl,
      (error: unknown) => {
        taskCdpUrl = undefined;
        throw error;
      }
    ));
  const running = new Map<string, RunningComputer>();
  const cleanupFailures = new Map<string, HttpError>();
  const retiring = new Set<Promise<void>>();
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const keyOf = (owner: string, threadId: string) => JSON.stringify([owner, threadId]);
  const touch = (computer: RunningComputer) => {
    const key = keyOf(computer.owner, computer.threadId);
    if (stopping || running.get(key) !== computer) return;
    clearTimeout(computer.idleTimer);
    computer.idleTimer = setTimeout(() => {
      running.delete(key);
      computer.startup.abort();
      const cleanup = computer.ready
        .then((browser) => browser.stop())
        .catch((error: unknown) => {
          if (error instanceof ComputerStartupCancelled) return;
          const failure = cleanupFailures.get(key) ?? new HttpError(503, 'Agent Computer idle cleanup failed');
          failure.cause = error;
          cleanupFailures.set(key, failure);
          console.error('Agent Computer idle cleanup failed', error);
        });
      retiring.add(cleanup);
      void cleanup.then(() => retiring.delete(cleanup));
    }, idleMs);
    computer.idleTimer.unref();
  };
  const start = (owner: string, threadId: string) => {
    if (stopping) throw new HttpError(503, 'Agent Computer task is stopping');
    const key = keyOf(owner, threadId);
    const cleanupFailure = cleanupFailures.get(key);
    if (cleanupFailure) throw cleanupFailure;
    const existing = running.get(key);
    if (existing && !existing.failure) {
      touch(existing);
      return existing;
    }
    const startup = new AbortController();
    const retire = () => {
      clearTimeout(computer.idleTimer);
      if (running.get(key) === computer) running.delete(key);
    };
    const ready = Promise.resolve().then(() => startLocalChromium(findChromium(env), startUrl, startup.signal)).then(
      (browser) => {
        void browser.closed.then(retire, (error: unknown) => {
          const failure = new HttpError(503, 'Agent Computer profile cleanup failed');
          failure.cause = error;
          cleanupFailures.set(key, failure);
          retire();
          console.error('Agent Computer exit cleanup failed', error);
        });
        return browser;
      },
      (error: unknown) => {
        clearTimeout(computer.idleTimer);
        if (error instanceof ComputerStartupCancelled) {
          retire();
          throw error;
        }
        const failure = new HttpError(
          503,
          `Agent Computer failed to start: ${error instanceof Error ? error.message : String(error)}`
        );
        failure.cause = error;
        computer.failure = failure;
        throw failure;
      }
    );
    const computer: RunningComputer = { owner, threadId, browserSessionId: randomUUID(), ready, startup };
    void ready.catch((error: unknown) => {
      console.error('Agent Computer startup failed', error);
    });
    running.set(key, computer);
    touch(computer);
    return computer;
  };
  const authorized = async (owner: string, threadId: string) =>
    (await history.owns(owner, threadId)) || (await history.ownsMainChat(owner, threadId));
  const requireOwner = async (owner: string, threadId: string) => {
    if (!(await authorized(owner, threadId))) throw new HttpError(404, 'This account does not own the Session');
    const failure = cleanupFailures.get(keyOf(owner, threadId));
    if (failure) throw failure;
  };
  const state = async (computer: RunningComputer | undefined): Promise<LocalComputerState> => {
    if (!computer || stopping) return ASLEEP;
    const browser = await computer.ready;
    if (!browser.alive) {
      await browser.closed;
      return ASLEEP;
    }
    if (computer.startup.signal.aborted || running.get(keyOf(computer.owner, computer.threadId)) !== computer)
      return ASLEEP;
    return { state: 'awake', browserSessionId: computer.browserSessionId, control: 'agent', screenshot: null };
  };
  const byBrowserSession = (browserSessionId: string) =>
    [...running.values()].find((candidate) => candidate.browserSessionId === browserSessionId);
  const ownedBrowser = async (sessionId: string, c: Context) => {
    const { owner } = await requester(c);
    const computer = byBrowserSession(sessionId);
    if (!computer || computer.owner !== owner || stopping || !(await authorized(owner, computer.threadId)))
      throw new HttpError(403, "Not this account's Agent Computer");
    return computer;
  };
  const computers = {
    async state(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      return state(running.get(keyOf(owner, threadId)));
    },
    async wake(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      return state(start(owner, threadId));
    },
  };

  const routes = new Hono();
  routes.get(
    '/agent-computer/cdp',
    agentComputerCdp({
      computers: {
        wake: computers.wake,
        use(owner, browserSessionId) {
          const computer = byBrowserSession(browserSessionId);
          if (!computer || computer.owner !== owner || stopping) return false;
          touch(computer);
          return true;
        },
        // Stopping its Chromium closes the stream, so a sleep needs no channel to let go first.
        claimStream: (owner, browserSessionId) => (byBrowserSession(browserSessionId)?.owner === owner ? () => undefined : null),
      },
      browser: () => ({
        async automationStream(browserSessionId) {
          const computer = byBrowserSession(browserSessionId);
          if (!computer || stopping) throw new Error('Agent Computer browser closed');
          return { endpoint: (await computer.ready).endpoint, headers: {} };
        },
        control: async () => 'agent',
      }),
      verify: tokens.verify,
    })
  );
  routes.get('/browser-live-view-url', async (c) => {
    const sessionId = c.req.query('session_id')?.trim();
    if (!sessionId) throw new HttpError(422, 'session_id must not be blank');
    const computer = await ownedBrowser(sessionId, c);
    const url = new URL('/agent-computer/view', c.req.url);
    url.searchParams.set('thread_id', computer.threadId);
    return c.json({ signedUrl: url.href });
  });
  for (const path of ['/browser-take-over', '/browser-hand-back']) {
    routes.post(path, async (c) => {
      await ownedBrowser(c.req.query('session_id') ?? '', c);
      throw new HttpError(501, 'Local Agent Computer Take-over is unavailable');
    });
  }
  routes.get('/agent-computer/view', async (c) => {
    const { owner } = await requester(c);
    const threadId = c.req.query('thread_id')?.trim();
    if (!threadId) throw new HttpError(422, 'thread_id must not be blank');
    await requireOwner(owner, threadId);
    const computer = running.get(keyOf(owner, threadId));
    if (!computer || stopping) throw new HttpError(409, 'Agent Computer is asleep');
    const image = await (await computer.ready).screenshot();
    return c.body(new Uint8Array(image), 200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  });

  return {
    /** The `/agent-computer/cdp`, live-view and Take-over routes; mount `computerFilesRoutes` over `state` and `wake`. */
    routes,
    ...computers,
    /** The Turn's `agentComputerCdpUrl`, tokened for the Session; the agent's connection wakes its computer. */
    async forwardedProps(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      const url = new URL(await ownCdpUrl());
      url.searchParams.set('token', tokens.issue(owner, threadId));
      return { agentComputerCdpUrl: url.href };
    },
    /** A Turn starts its Session's computer without waiting for it, so the agent's first command joins it. */
    turnStarting({ owner }: Requester, threadId: string) {
      start(owner, threadId);
    },
    async browserLiveView({ owner }: Requester, threadId: string) {
      const computer = running.get(keyOf(owner, threadId));
      return (await authorized(owner, threadId)) &&
        computer &&
        !stopping &&
        !computer.failure &&
        !computer.startup.signal.aborted
        ? { open: true as const, sessionId: computer.browserSessionId }
        : null;
    },
    async warmSession({ owner }: Requester, threadId: string) {
      await requireOwner(owner, threadId);
      await start(owner, threadId).ready;
    },
    async authorizeBrowserLiveView(sessionId: string, c: Context) {
      await ownedBrowser(sessionId, c);
      return 'local-agent-computer';
    },
    /** The task is stopping: cancel pending starts and stop every computer; fails with any profile cleanup that failed. */
    stop() {
      return (stopped ??= (async () => {
        stopping = true;
        await Promise.all(
          [...running.values()]
            .map(async (computer) => {
              clearTimeout(computer.idleTimer);
              computer.startup.abort();
              try {
                await (await computer.ready).stop();
              } catch (error) {
                if (!(error instanceof ComputerStartupCancelled)) {
                  const failure = cleanupFailures.get(keyOf(computer.owner, computer.threadId));
                  if (failure) throw failure;
                  throw error;
                }
              }
            })
            .concat([...retiring])
            .concat([...cleanupFailures.values()].map((failure) => Promise.reject(failure)))
        );
        running.clear();
        if (cleanupFailures.size) throw [...cleanupFailures.values()][0];
      })());
    },
  };
}
