import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { required } from './required.js';

export interface RunningProcess {
  readonly url: string;
  output(): string;
  stop(): Promise<void>;
}

interface StartOptions {
  command: string;
  env: NodeJS.ProcessEnv;
  url: string;
  /** What the process prints once it holds its port: only then is an answer on the port its own. */
  listening: string;
  readyTimeoutMs?: number;
}

// A process that exits because another took its port first.
class PortTakenError extends Error {}

const ADDRESS_IN_USE = /EADDRINUSE|address already in use/i;
const PORT_ATTEMPTS = 3;

/**
 * The address every server in the suite binds, as the Chat Service and the Harness do: two servers on one port then
 * collide loudly on every OS, where macOS would let a loopback server keep answering for a wildcard one.
 */
export const BIND_ADDRESS = '0.0.0.0';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, BIND_ADDRESS, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not allocate a local port');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

// Whether anything answers at `url` yet.
const answers = (url: string) =>
  fetch(url).then(
    () => true,
    () => false,
  );

/**
 * Start a shell command as its own process group and wait until it says it holds its port and `url` answers
 * any HTTP request; stop() kills the whole group. An answer alone is not enough: another server can take the
 * free port before the process binds it, and answer for it while the process exits.
 */
export async function startProcess(options: StartOptions): Promise<RunningProcess> {
  const child = spawn(options.command, {
    shell: true,
    detached: true,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  // A shell can exit before its service child finishes SIGTERM cleanup; inherited pipes close only once that child ends.
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-required(child.pid, 'process group id'), 'SIGTERM');
      await exited;
    }
  };
  const readyTimeoutMs = options.readyTimeoutMs ?? 45_000;
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      const Exited = ADDRESS_IN_USE.test(output) ? PortTakenError : Error;
      throw new Exited(`\`${options.command}\` exited with ${child.exitCode}:\n${output}`);
    }
    // eslint-disable-next-line no-await-in-loop -- polls until the process answers or the deadline passes
    if (output.includes(options.listening) && (await answers(options.url))) break;
    if (Date.now() > deadline) {
      // eslint-disable-next-line no-await-in-loop -- polls until the process answers or the deadline passes
      await stop();
      throw new Error(`\`${options.command}\` did not print "${options.listening}" and answer ${options.url} within ${readyTimeoutMs}ms:\n${output}`);
    }
    // eslint-disable-next-line no-await-in-loop -- polls until the process answers or the deadline passes
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { url: options.url, output: () => output, stop };
}

/**
 * Start a process on a free local port, as startProcess does. A free port stays free only until
 * another process binds it, which can happen between the probe and the start: then the start is
 * retried on a fresh port.
 */
export async function startOnFreePort(options: (port: number) => StartOptions): Promise<RunningProcess> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retries on another port when the chosen one is taken
      return await startProcess(options(await freePort()));
    } catch (error) {
      if (!(error instanceof PortTakenError) || attempt === PORT_ATTEMPTS) throw error;
    }
  }
}
