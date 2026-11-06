import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
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

function observeStartup(child: ChildProcess, executable: string, args: string[], started: number) {
  let stderr = '';
  let stderrBytes = 0;
  let devToolsMs: number | null = null;
  const record = (event: string, detail: object = {}) => {
    const cpuTimes = cpus().reduce((total, cpu) => {
      for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) total[key] += cpu.times[key];
      return total;
    }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
    console.error('Chromium startup diagnostic', JSON.stringify({
      event, pid: child.pid ?? null, elapsedMs: performance.now() - started, devToolsMs,
      host: { availableCpus: availableParallelism(), cpuTimes, loadavg: loadavg(), freeMemory: freemem(), totalMemory: totalmem() },
      ...detail,
    }));
  };
  record('launch', { executable, args });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr = (stderr + chunk.toString()).slice(-16_384);
    if (devToolsMs === null && /DevTools listening on ws:\/\//.test(stderr)) {
      devToolsMs = performance.now() - started;
      record('devtools');
    }
  });
  child.once('close', (code, signal) => record('close', { code, signal, stderr, stderrBytes, stderrTruncated: stderrBytes > Buffer.byteLength(stderr) }));
  return record;
}

/** Start headless Chromium on `startPage`; answers once its DevTools endpoint has a page. */
export async function startLocalChromium(
  chromiumPath: string,
  startPage: string,
  signal: AbortSignal,
  diagnostics = false
): Promise<LocalChromium> {
  const profile = await mkdtemp(join(tmpdir(), 'agent-computer-'));
  if (signal.aborted) {
    await rm(profile, { recursive: true, force: true });
    throw new ComputerStartupCancelled();
  }
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    // Without it, each temporary profile asks the macOS login keychain for a "Chrome" item, which can raise "Keychain Not Found".
    '--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--window-size=1280,720',
    `--user-data-dir=${profile}`,
    startPage,
  ];
  const started = performance.now();
  const child = spawn(
    chromiumPath,
    args,
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const record = diagnostics ? observeStartup(child, chromiumPath, args, started) : undefined;
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => resolve())
  );
  const cleaned = exited.then(() =>
    rm(profile, { recursive: true, force: true })
  );
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      record?.('stop-requested', { signal: 'SIGTERM' });
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        record?.('stop-requested', { signal: 'SIGKILL' });
        child.kill('SIGKILL');
      }, 2000);
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
    record?.('startup-failed', { error: error instanceof Error ? error.message : String(error) });
    await stop();
    throw error;
  }
}
