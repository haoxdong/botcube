/** A CDP message the agent receives: a command answer (with `id`) or an event (with `method`). */
export interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** The agent's browser tool, speaking CDP to the URL the Chat Service gave it for a Turn. */
export class AgentCdp {
  private nextId = 1;
  readonly received: CdpMessage[] = [];
  private readonly waiters = new Set<() => void>();

  private constructor(
    private readonly socket: WebSocket,
    readonly closed: Promise<{ code: number; reason: string }>
  ) {
    socket.addEventListener('message', (event) => {
      this.received.push(JSON.parse(String(event.data)) as CdpMessage);
      for (const waiter of this.waiters) waiter();
    });
  }

  /** Connect; answers the open connection, or how the Chat Service refused or closed it. */
  static async connect(url: string): Promise<AgentCdp> {
    const socket = new WebSocket(url);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`CDP connection to ${url} refused`)), { once: true });
    });
    return new AgentCdp(socket, closed);
  }

  private until<T>(found: () => T | undefined, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`No ${what} within 5s`));
      }, 5000);
      const check = () => {
        const value = found();
        if (value === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value);
      };
      this.waiters.add(check);
      check();
    });
  }

  /** Send a command; answers its reply, error or result. */
  async send(method: string, params: object = {}, sessionId?: string): Promise<CdpMessage> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return this.until(() => this.received.find((message) => message.id === id), `answer to ${method}`);
  }

  /** Wait for an event. */
  event(method: string): Promise<CdpMessage> {
    return this.until(() => this.received.find((message) => message.method === method), method);
  }

  close(): void {
    this.socket.close();
  }
}
