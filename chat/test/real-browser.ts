import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { testChromiumPath } from './chromium.js';

export async function realSingleClientBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-browser-'));
  const chrome = spawn(testChromiumPath(), ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', (data: Buffer) => {
      output += data.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match?.[1]) resolve(match[1]);
    });
    chrome.on('error', reject);
    chrome.on('exit', () => reject(new Error('Chromium exited before publishing its CDP endpoint')));
  });
  let admissions = 0;
  let refusals = 0;
  const upstreams = new Set<WebSocket>();
  const stream = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (_info, admit) => {
    if (stream.clients.size) { refusals++; admit(false, 429, 'Concurrent connections to the same session are not supported'); }
    else { admissions++; admit(true); }
  } });
  await new Promise<void>((resolve) => stream.on('listening', resolve));
  stream.on('connection', (client) => {
    const upstream = new WebSocket(endpoint);
    upstreams.add(upstream);
    const pending: Buffer[] = [];
    client.on('message', (data: Buffer) => upstream.readyState === WebSocket.OPEN ? upstream.send(data.toString()) : pending.push(data));
    upstream.on('open', () => { for (const data of pending) upstream.send(data.toString()); });
    upstream.on('message', (data: Buffer) => client.send(data.toString()));
    upstream.on('close', () => { upstreams.delete(upstream); client.close(); });
    upstream.on('error', () => client.close());
    client.on('close', () => upstream.close());
  });
  const pages = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<html><head><title>${request.url === '/second' ? 'Second page' : 'First page'}</title></head><body>${request.url === '/second' ? 'second public body' : 'first public body'}</body></html>`);
  });
  await new Promise<void>((resolve) => pages.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `ws://127.0.0.1:${(stream.address() as AddressInfo).port}/automation`,
    page: `http://127.0.0.1:${(pages.address() as AddressInfo).port}`,
    counts: () => ({ admissions, refusals }),
    async close() {
      const stopped = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      for (const socket of stream.clients) socket.terminate();
      for (const socket of upstreams) socket.terminate();
      await new Promise<void>((resolve) => stream.close(() => resolve()));
      pages.closeAllConnections();
      await new Promise<void>((resolve) => pages.close(() => resolve()));
      chrome.kill('SIGTERM');
      await stopped;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export function realBrowserClient(endpoint: string, session: string) {
  const binary = fileURLToPath(new URL('../node_modules/.bin/agent-browser', import.meta.url));
  return (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(binary, ['--session', session, ...args], { env: { ...process.env, AGENT_BROWSER_CDP: endpoint }, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message));
      else resolve(stdout);
    });
  });
}
