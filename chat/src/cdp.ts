/** A CDP message: a command response (with `id`) or an event (with `method`). */
interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A Chrome DevTools Protocol connection over a WebSocket. */
export class Cdp {
  private nextId = 1;
  private readonly waiters = new Set<(message: CdpMessage) => boolean>();
  private closedError: Error | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      for (const waiter of [...this.waiters]) if (waiter(message)) this.waiters.delete(waiter);
    });
    socket.addEventListener('close', () => {
      this.closedError = new Error('CDP connection closed');
      for (const waiter of [...this.waiters]) waiter({});
    });
  }

  static async connect(url: string, headers?: Record<string, string>): Promise<Cdp> {
    // Node's WebSocket (undici) takes upgrade-request headers, which the
    // AWS-authenticated automation stream needs.
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`CDP connection to ${url} failed`)), { once: true });
    });
    return new Cdp(socket);
  }

  /** Wait until `matches` accepts a message, within `timeoutMs`. */
  private wait(matches: (message: CdpMessage) => boolean, timeoutMs: number, what: string): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`No CDP ${what} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      const waiter = (message: CdpMessage) => {
        if (this.closedError !== null) {
          clearTimeout(timer);
          reject(this.closedError);
          return true;
        }
        if (!matches(message)) return false;
        clearTimeout(timer);
        resolve(message);
        return true;
      };
      this.waiters.add(waiter);
    });
  }

  /** Send a command and wait for its response. */
  async send(
    method: string,
    { params, sessionId, timeoutMs = 10_000 }: { params?: object | undefined; sessionId?: string; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = this.wait((message) => message.id === id, timeoutMs, `response for id=${id}`);
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    const answer = await response;
    if (answer.error !== undefined) {
      throw new Error(`CDP ${method} failed (${answer.error.code}): ${answer.error.message}`);
    }
    return answer.result ?? {};
  }

  /** The first page target. */
  async pageTarget(): Promise<{ targetId: string; url: string }> {
    const { targetInfos } = (await this.send('Target.getTargets')) as {
      targetInfos?: { targetId: string; type: string; url: string }[];
    };
    const target = (targetInfos ?? []).find(({ type }) => type === 'page');
    if (target === undefined) throw new Error('No page target found in auth browser session');
    return target;
  }

  /** Attach to the first page target; answers its CDP session ID. */
  async attachToPage(): Promise<string> {
    const { targetId } = await this.pageTarget();
    const { sessionId } = (await this.send('Target.attachToTarget', { params: { targetId, flatten: true } })) as {
      sessionId?: string;
    };
    if (!sessionId) throw new Error('Failed to attach to page target');
    return sessionId;
  }

  /** Enable the network, runtime and page domains on a page session. */
  async enablePageDomains(sessionId: string): Promise<void> {
    // eslint-disable-next-line no-await-in-loop -- enables the domains in order on one CDP session
    for (const method of ['Network.enable', 'Runtime.enable', 'Page.enable']) await this.send(method, { sessionId });
  }

  /** Every cookie the browser holds, as CDP reports them. */
  async allCookies(sessionId: string): Promise<Record<string, unknown>[]> {
    const { cookies } = (await this.send('Network.getAllCookies', { sessionId })) as {
      cookies?: Record<string, unknown>[];
    };
    return cookies ?? [];
  }

  close(): void {
    this.socket.close();
  }
}
