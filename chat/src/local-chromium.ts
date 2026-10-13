import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { HttpError } from './cartridge.js';
import { Cdp } from './cdp.js';

export class ComputerStartupCancelled extends HttpError {
  constructor() {
    super(503, 'Agent Computer startup was cancelled');
  }
}

/** The names Chromium and Chrome install under on PATH. */
const CHROMIUM_COMMANDS = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];
/** Where macOS installs them, off PATH. */
const CHROMIUM_APPS = [
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** BOTCUBE_CHROMIUM_PATH, else the first Chromium or Chrome on PATH or in /Applications; throws naming the fix when there is none. */
export function findChromium(env: NodeJS.ProcessEnv): string {
  const configured = env.BOTCUBE_CHROMIUM_PATH?.trim();
  if (configured) return configured;
  const candidates = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => CHROMIUM_COMMANDS.map((name) => join(dir, name)))
    .concat(CHROMIUM_APPS);
  const found = candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!found)
    throw new Error(
      `No Chromium found on PATH (${CHROMIUM_COMMANDS.join(', ')}) or in /Applications: install Chromium or set BOTCUBE_CHROMIUM_PATH`
    );
  return found;
}

/** A Chromium process on this Chat Service's host, with a private profile it deletes on exit. */
export interface LocalChromium {
  readonly endpoint: string;
  readonly alive: boolean;
  readonly closed: Promise<void>;
  screenshot(): Promise<Buffer>;
  stop(): Promise<void>;
}

async function command(endpoint: string, method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> {
  const cdp = await Cdp.connect(endpoint);
  try { return await cdp.send(method, { params, ...(sessionId ? { sessionId } : {}) }); } finally { cdp.close(); }
}

/** Start headless Chromium on `startPage`; answers once its DevTools endpoint has a page. */
export async function startLocalChromium(
  chromiumPath: string,
  startPage: string,
  signal: AbortSignal
): Promise<LocalChromium> {
  const profile = await mkdtemp(join(tmpdir(), 'agent-computer-'));
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
      startPage,
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
      child.once('error', (error: NodeJS.ErrnoException) =>
        finish(
          error.code === 'ENOENT'
            ? new Error(`Chromium is not installed at ${chromiumPath} (ENOENT): install it or set BOTCUBE_CHROMIUM_PATH`, { cause: error })
            : error
        )
      );
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
