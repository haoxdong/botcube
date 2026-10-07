import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from 'botcube-chat';

export class ComputerStartupCancelled extends HttpError {
  constructor() {
    super(503, 'Agent Computer startup was cancelled');
  }
}

export interface LocalComputer {
  readonly endpoint: string;
  readonly alive: boolean;
  readonly closed: Promise<void>;
  screenshot(): Promise<Buffer>;
  stop(): Promise<void>;
}

async function command(
  endpoint: string,
  method: string,
  params: object = {},
  sessionId?: string
): Promise<Record<string, unknown>> {
  const socket = new WebSocket(endpoint);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Agent Computer ${method} timed out`)),
        10_000
      );
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error(`Agent Computer ${method} answered no result`));
      };
      socket.addEventListener('error', () =>
        finish(new Error(`Agent Computer ${method} connection failed`))
      );
      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ id: 1, method, params, sessionId }))
      );
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            id?: number;
            result?: Record<string, unknown>;
            error?: { message: string };
          };
          if (message.id !== 1) return;
          if (message.error) finish(new Error(message.error.message));
          else if (message.result) finish(undefined, message.result);
          else finish(new Error(`Agent Computer ${method} answered no result`));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    socket.close();
  }
}

export async function startLocalComputer(
  chromiumPath: string,
  siteUrl: string,
  signal: AbortSignal
): Promise<LocalComputer> {
  const profile = await mkdtemp(join(tmpdir(), 'template-computer-'));
  if (signal.aborted) {
    await rm(profile, { recursive: true, force: true });
    throw new ComputerStartupCancelled();
  }
  const child = spawn(
    chromiumPath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--window-size=1280,720',
      `--user-data-dir=${profile}`,
      new URL('/login', siteUrl).href,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => resolve())
  );
  const cleaned = exited.then(() =>
    rm(profile, { recursive: true, force: true })
  );
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await cleaned;
      } finally {
        clearTimeout(timer);
      }
    })());
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let waitingFor = 'the DevTools endpoint';
      const timer = setTimeout(
        () => reject(new Error(`Agent Computer Chromium startup timed out while waiting for ${waitingFor}`)),
        10_000
      );
      let output = '';
      let discovery: WebSocket | undefined;
      const finish = (error?: Error, value?: string) => {
        clearTimeout(timer);
        child.stderr.off('data', read);
        signal.removeEventListener('abort', abort);
        discovery?.close();
        if (error) reject(error);
        else if (value) resolve(value);
      };
      child.once('error', (error) => finish(error));
      child.once('close', () =>
        finish(new Error('Agent Computer Chromium exited before startup'))
      );
      const read = (data: Buffer) => {
        output += data.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (!match?.[1] || discovery) return;
        const endpoint = match[1];
        waitingFor = 'the DevTools connection';
        discovery = new WebSocket(endpoint);
        discovery.addEventListener('error', () =>
          finish(new Error('Agent Computer page discovery failed'))
        );
        discovery.addEventListener('open', () => {
          waitingFor = 'a page target';
          discovery?.send(
            JSON.stringify({
              id: 1,
              method: 'Target.setDiscoverTargets',
              params: { discover: true },
            })
          );
        });
        discovery.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as {
              method?: string;
              params?: { targetInfo?: { type?: string } };
              error?: { message: string };
            };
            if (message.error) finish(new Error(message.error.message));
            else if (
              message.method === 'Target.targetCreated' &&
              message.params?.targetInfo?.type === 'page'
            )
              finish(undefined, endpoint);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };
      const abort = () => {
        child.kill('SIGTERM');
        finish(new ComputerStartupCancelled());
      };
      child.stderr.on('data', read);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return {
      endpoint,
      get alive() {
        return child.exitCode === null && child.signalCode === null;
      },
      closed: cleaned,
      async screenshot() {
        const url = new URL(endpoint);
        url.protocol = 'http:';
        url.pathname = '/json/list';
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(
            `Agent Computer page list returned HTTP ${response.status}`
          );
        const targets = (await response.json()) as {
          type: string;
          webSocketDebuggerUrl: string;
        }[];
        const page = targets.find((target) => target.type === 'page');
        if (!page) throw new Error('Agent Computer has no page');
        const { data } = await command(
          page.webSocketDebuggerUrl,
          'Page.captureScreenshot',
          { format: 'png' }
        );
        if (typeof data !== 'string' || !data)
          throw new Error('Agent Computer answered no screenshot');
        return Buffer.from(data, 'base64');
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
