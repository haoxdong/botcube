import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BIND_ADDRESS } from './process.js';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type Handler = (
  request: RecordedRequest,
  response: ServerResponse
) => void | Promise<void>;

/** A local HTTP server that records every request before handing it to `handle`. */
export class HttpFake {
  readonly requests: RecordedRequest[] = [];
  readonly server: Server;
  url = '';
  private closing = false;
  /** Rechecks of pending waitForRequests conditions, run as each request is recorded. */
  private readonly waiters = new Set<() => void>();

  constructor(handle: Handler) {
    this.server = createServer((incoming, response) => {
      this.serve(incoming, response, handle).catch((error: unknown) => {
        if (!this.closing) throw error;
      });
    });
  }

  private async serve(incoming: IncomingMessage, response: ServerResponse, handle: Handler): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const request: RecordedRequest = {
      method: incoming.method ?? '',
      path: incoming.url ?? '',
      headers: incoming.headers,
      body: Buffer.concat(chunks).toString(),
    };
    this.requests.push(request);
    for (const recheck of [...this.waiters]) recheck();
    await handle(request, response);
  }

  /** Resolve once `condition` holds over the recorded requests: now, or after a later request is recorded. */
  async waitForRequests(condition: () => boolean): Promise<void> {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      const recheck = () => {
        if (!condition()) return;
        this.waiters.delete(recheck);
        resolve();
      };
      this.waiters.add(recheck);
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, BIND_ADDRESS, resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
