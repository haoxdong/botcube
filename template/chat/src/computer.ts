import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  HttpError,
  deniesCommand,
  filterEvent,
  type CdpMessage,
  upgradeWebSocket,
  type AccountHistory,
  type Requester,
} from 'botcube-chat';
import { Hono, type Context } from 'hono';
import type { WSContext } from 'hono/ws';
import {
  ComputerStartupCancelled,
  startLocalComputer,
  type LocalComputer,
} from './local-computer.js';
import { invocationToken } from './sign-in.js';

interface RunningComputer {
  readonly owner: string;
  readonly threadId: string;
  readonly browserSessionId: string;
  readonly ready: Promise<LocalComputer>;
  readonly channels: Set<WSContext>;
  readonly startup: AbortController;
  failure?: HttpError;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export function templateComputer({
  history,
  requester,
  siteUrl,
  cdpUrl,
  chromiumPath,
}: {
  history: AccountHistory;
  requester: (c: Context) => Promise<Requester>;
  siteUrl: string;
  cdpUrl: string;
  chromiumPath: string;
}) {
  const running = new Map<string, RunningComputer>();
  const cleanupFailures = new Map<string, HttpError>();
  const retiring = new Set<Promise<void>>();
  const secret = randomBytes(32).toString('base64url');
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const keyOf = (owner: string, threadId: string) =>
    JSON.stringify([owner, threadId]);
  const touch = (computer: RunningComputer) => {
    const key = keyOf(computer.owner, computer.threadId);
    if (stopping || running.get(key) !== computer) return;
    clearTimeout(computer.idleTimer);
    computer.idleTimer = setTimeout(
      () => {
        running.delete(key);
        computer.startup.abort();
        for (const channel of computer.channels)
          channel.close(1001, 'Agent Computer slept');
        const cleanup = computer.ready
          .then((browser) => browser.stop())
          .catch((error: unknown) => {
            if (error instanceof ComputerStartupCancelled) return;
            const failure =
              cleanupFailures.get(key) ??
              new HttpError(503, 'Agent Computer idle cleanup failed');
            failure.cause = error;
            cleanupFailures.set(key, failure);
            console.error('Agent Computer idle cleanup failed', error);
          });
        retiring.add(cleanup);
        void cleanup.then(() => retiring.delete(cleanup));
      },
      10 * 60 * 1000
    );
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
      for (const channel of computer.channels)
        channel.close(1001, 'Agent Computer slept');
    };
    const ready = startLocalComputer(
      chromiumPath,
      siteUrl,
      startup.signal
    ).then(
      (browser) => {
        void browser.closed.then(retire, (error: unknown) => {
          const failure = new HttpError(
            503,
            'Agent Computer profile cleanup failed'
          );
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
        const failure = new HttpError(503, `Agent Computer failed to start: ${error instanceof Error ? error.message : String(error)}`);
        failure.cause = error;
        computer.failure = failure;
        throw failure;
      }
    );
    const computer: RunningComputer = {
      owner,
      threadId,
      browserSessionId: randomUUID(),
      ready,
      channels: new Set<WSContext>(),
      startup,
    };
    void ready.catch((error: unknown) => {
      console.error('Agent Computer startup failed', error);
    });
    running.set(key, computer);
    touch(computer);
    return computer;
  };
  const authorized = async (owner: string, threadId: string) =>
    await history.owns(owner, threadId) || await history.ownsMainChat(owner, threadId);
  const requireOwner = async (owner: string, threadId: string) => {
    if (!(await authorized(owner, threadId)))
      throw new HttpError(404, 'This account does not own the Session');
  };
  const current = async (c: Context) => {
    const { owner } = await requester(c);
    const threadId = c.req.query('thread_id')?.trim();
    if (!threadId) throw new HttpError(422, 'thread_id must not be blank');
    await requireOwner(owner, threadId);
    const failure = cleanupFailures.get(keyOf(owner, threadId));
    if (failure) throw failure;
    return { owner, threadId };
  };
  const state = async (computer: RunningComputer | undefined) => {
    if (!computer || stopping)
      return { state: 'asleep' as const, screenshot: null };
    const browser = await computer.ready;
    if (!browser.alive) {
      await browser.closed;
      return { state: 'asleep' as const, screenshot: null };
    }
    if (
      computer.startup.signal.aborted ||
      running.get(keyOf(computer.owner, computer.threadId)) !== computer
    )
      return { state: 'asleep' as const, screenshot: null };
    return {
      state: 'awake' as const,
      browserSessionId: computer.browserSessionId,
      control: 'agent' as const,
      screenshot: null,
    };
  };
  const routes = new Hono();
  const ownedBrowser = async (sessionId: string, c: Context) => {
    const { owner } = await requester(c);
    const computer = [...running.values()].find(
      (candidate) => candidate.browserSessionId === sessionId
    );
    if (!computer || computer.owner !== owner || stopping || !(await authorized(owner, computer.threadId)))
      throw new HttpError(403, "Not this account's Agent Computer");
    return computer;
  };
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
  routes.get('/agent-computer', async (c) => {
    const { owner, threadId } = await current(c);
    return c.json(await state(running.get(keyOf(owner, threadId))));
  });
  routes.post('/agent-computer/wake', async (c) => {
    const { owner, threadId } = await current(c);
    return c.json(await state(start(owner, threadId)));
  });
  routes.get('/agent-computer/view', async (c) => {
    const { owner, threadId } = await current(c);
    const computer = running.get(keyOf(owner, threadId));
    if (!computer || stopping)
      throw new HttpError(409, 'Agent Computer is asleep');
    const image = await (await computer.ready).screenshot();
    return c.body(new Uint8Array(image), 200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
    });
  });
  routes.get(
    '/agent-computer/cdp',
    upgradeWebSocket(async (c) => {
      let computer: RunningComputer;
      try {
        const parts = (c.req.query('token') ?? '').split('.');
        const [version, payload, signature] = parts;
        if (
          parts.length !== 3 ||
          version !== 'v1' ||
          !payload ||
          !signature ||
          stopping
        )
          throw new Error('Invalid token');
        const expected = createHmac('sha256', secret).update(payload).digest();
        const supplied = Buffer.from(signature, 'base64url');
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new Error('Invalid signature');
        const claims = JSON.parse(
          Buffer.from(payload, 'base64url').toString()
        ) as Record<string, unknown>;
        if (
          typeof claims.account_id !== 'string' ||
          typeof claims.session_id !== 'string' ||
          typeof claims.expires_at !== 'number' ||
          claims.expires_at <= Date.now() / 1000
        )
          throw new Error('Invalid claims');
        const active = running.get(keyOf(claims.account_id, claims.session_id));
        if (!active || claims.scope !== `computer:${active.browserSessionId}`)
          throw new Error('Computer retired');
        computer = active;
      } catch {
        throw new HttpError(401, 'Invalid Agent Computer token');
      }
      await requireOwner(computer.owner, computer.threadId);
      let upstream: WebSocket | undefined;
      let closed = false;
      const waiting: string[] = [];
      async function open(agent: WSContext) {
        const browser = await computer.ready;
        if (closed || stopping || computer.startup.signal.aborted) return;
        upstream = new WebSocket(browser.endpoint);
        upstream.addEventListener('open', () => {
          for (const command of waiting.splice(0)) upstream?.send(command);
        });
        upstream.addEventListener('message', (event) => {
          const message = filterEvent(
            JSON.parse(String(event.data)) as CdpMessage
          );
          if (message) agent.send(JSON.stringify(message));
        });
        upstream.addEventListener('close', () =>
          agent.close(1001, 'Agent Computer slept')
        );
        upstream.addEventListener('error', () =>
          agent.close(1011, 'Agent Computer connection failed')
        );
      }
      return {
        onOpen(_event, agent) {
          computer.channels.add(agent);
          void open(agent).catch((error: unknown) => {
            console.error('Agent Computer channel failed', error);
            agent.close(1011, 'Agent Computer failed to start');
          });
        },
        onMessage(event, agent) {
          if (typeof event.data !== 'string') {
            agent.close(1003, 'Agent Computer CDP requires text');
            return;
          }
          let command: CdpMessage;
          try {
            const parsed: unknown = JSON.parse(event.data);
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              Array.isArray(parsed)
            )
              throw new Error('Invalid CDP command');
            command = parsed as CdpMessage;
          } catch {
            agent.close(1003, 'Agent Computer CDP requires a command object');
            return;
          }
          if (deniesCommand(command)) {
            agent.send(
              JSON.stringify({
                id: command.id,
                sessionId: command.sessionId,
                error: {
                  code: -32000,
                  message: `${String(command.method)} is not allowed on the Agent Computer`,
                },
              })
            );
            return;
          }
          touch(computer);
          if (upstream?.readyState === WebSocket.OPEN)
            upstream.send(event.data);
          else waiting.push(event.data);
        },
        onClose(_event, agent) {
          closed = true;
          computer.channels.delete(agent);
          upstream?.close();
        },
      };
    })
  );
  return {
    routes,
    async forwardedProps(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      const computer = start(owner, threadId);
      const token = invocationToken(
        secret,
        owner,
        threadId,
        `computer:${computer.browserSessionId}`
      );
      const url = new URL(cdpUrl);
      url.searchParams.set('token', token);
      return {
        agentComputerCdpUrl: url.href,
      };
    },
    async browserLiveView({ owner }: Requester, threadId: string) {
      const computer = running.get(keyOf(owner, threadId));
      return await authorized(owner, threadId) && computer && !stopping && !computer.failure && !computer.startup.signal.aborted
        ? { open: true as const, sessionId: computer.browserSessionId }
        : null;
    },
    async warmSession({ owner }: Requester, threadId: string) {
      await requireOwner(owner, threadId);
      await start(owner, threadId).ready;
    },
    async authorizeBrowserLiveView(sessionId: string, c: Context) {
      await ownedBrowser(sessionId, c);
      return 'template-local-computer';
    },
    stop() {
      return (stopped ??= (async () => {
        stopping = true;
        await Promise.all(
          [...running.values()]
            .map(async (computer) => {
              for (const channel of computer.channels)
                channel.close(1001, 'Agent Computer slept');
              clearTimeout(computer.idleTimer);
              computer.startup.abort();
              try {
                await (await computer.ready).stop();
              } catch (error) {
                if (!(error instanceof ComputerStartupCancelled)) {
                  const failure = cleanupFailures.get(
                    keyOf(computer.owner, computer.threadId)
                  );
                  if (failure) throw failure;
                  throw error;
                }
              }
            })
            .concat([...retiring])
            .concat(
              [...cleanupFailures.values()].map((failure) =>
                Promise.reject(failure)
              )
            )
        );
        running.clear();
        if (cleanupFailures.size) throw [...cleanupFailures.values()][0];
      })());
    },
  };
}

export function templateComputerConfig(env: NodeJS.ProcessEnv) {
  if (!env.TEMPLATE_SITE_URL && !env.TEMPLATE_CHROMIUM_PATH) return null;
  if (!env.TEMPLATE_SITE_URL || !env.TEMPLATE_CHROMIUM_PATH)
    throw new Error(
      'Agent Computer needs TEMPLATE_SITE_URL and TEMPLATE_CHROMIUM_PATH'
    );
  return {
    siteUrl: new URL(env.TEMPLATE_SITE_URL).origin,
    chromiumPath: env.TEMPLATE_CHROMIUM_PATH,
    cdpUrl:
      env.TEMPLATE_COMPUTER_CDP_URL ??
      `ws://127.0.0.1:${env.PORT ?? '8123'}/agent-computer/cdp`,
  };
}
