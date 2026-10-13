import type { CdpMessage } from './cdp-filter.js';
import { traceSocket, traceClose, traceFailure, traceAttachment, traceReference, type ComputerTrace } from './agent-computer-trace.js';

export interface CdpChannel {
  send(data: string): void;
  close(): Promise<void>;
}

interface Listener {
  message(message: CdpMessage): void;
  closed(): void;
}

interface Client extends Listener {
  root: string;
}

type Pending =
  | { kind: 'internal'; resolve(message: CdpMessage): void; reject(error: Error): void }
  | { kind: 'client'; client: Client; id: number | undefined; sessionId: string | undefined };

class Transport {
  private readonly clients = new Set<Client>();
  private readonly sessions = new Map<string, Client>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private state: 'opening' | 'open' | 'closing' | 'closed' = 'opening';
  private readonly ready: Promise<void>;
  readonly ended: Promise<void>;
  private end!: () => void;

  constructor(private readonly socket: WebSocket, release: () => void, private readonly trace: ComputerTrace, readonly reference: string) {
    this.ended = new Promise((resolve) => { this.end = resolve; });
    let connected = false;
    this.ready = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => {
        this.trace('upstream.open');
        connected = true;
        this.state = 'open';
        resolve();
      });
      socket.addEventListener('error', () => reject(new Error('Agent Computer browser could not be reached')));
      socket.addEventListener('close', () => reject(new Error('Agent Computer browser closed')));
    });
    socket.addEventListener('message', (event) => this.receive(JSON.parse(String(event.data)) as CdpMessage));
    const ended = () => {
      if (this.state === 'closed') return;
      this.state = 'closed';
      release();
      this.trace('claim.release', { clients: this.clients.size, pending: this.pending.size });
      const error = new Error('Agent Computer browser closed');
      for (const pending of this.pending.values()) if (pending.kind === 'internal') pending.reject(error);
      this.pending.clear();
      this.sessions.clear();
      this.end();
      for (const client of this.clients) client.closed();
      this.clients.clear();
    };
    socket.addEventListener('close', (event) => { this.trace('upstream.close', traceClose(event)); ended(); });
    socket.addEventListener('error', (event) => {
      this.trace('upstream.error', traceFailure((event as ErrorEvent).error));
      if (!connected) ended();
      else socket.close();
    });
  }

  get retiring(): boolean { return this.state === 'closing' || this.state === 'closed'; }

  async close(): Promise<void> {
    if (this.retiring) return this.ended;
    this.trace('upstream.close-request', { clients: this.clients.size, pending: this.pending.size });
    this.state = 'closing';
    this.socket.close();
    return this.ended;
  }

  async opened(): Promise<void> { await this.ready; }

  private allocateId(): number {
    return this.nextId++;
  }

  private command(method: string, params: Record<string, unknown>): Promise<CdpMessage> {
    if (this.state !== 'open') return Promise.reject(new Error('Agent Computer browser closed'));
    const id = this.allocateId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: 'internal', resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async join(listener: Listener, caller: ComputerTrace): Promise<CdpChannel> {
    const reference = traceReference();
    const trace: ComputerTrace = (step, fields) => caller(step, { ...fields, client: reference, transport: this.reference });
    await this.ready;
    if (this.retiring) throw new Error('Agent Computer browser closed');
    const client: Client = { ...listener, root: '' };
    this.clients.add(client);
    try {
      trace('root.attach-start', { clients: this.clients.size });
      const response = await this.command('Target.attachToBrowserTarget', {});
      trace('root.attach-result', traceAttachment(response));
      const result = response.result as { sessionId?: string } | undefined;
      if (typeof result?.sessionId !== 'string') throw new Error('Agent Computer browser did not attach a CDP session');
      client.root = result.sessionId;
      this.sessions.set(client.root, client);
    } catch (error) {
      trace('root.attach-error', traceFailure(error));
      this.clients.delete(client);
      if (this.clients.size === 0) await this.close();
      throw error;
    }
    let closed = false;
    return {
      send: (data) => {
        if (closed || this.state !== 'open') throw new Error('Agent Computer browser closed');
        const message = JSON.parse(data) as CdpMessage;
        const targets = [message.sessionId, typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined];
        if (targets.some((target) => target !== undefined && this.sessions.has(target) && this.sessions.get(target) !== client)) {
          client.message({ ...(message.id === undefined ? {} : { id: message.id }), ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
            error: { code: -32000, message: 'CDP session belongs to another browser client' } });
          return;
        }
        const id = this.allocateId();
        this.pending.set(id, { kind: 'client', client, id: message.id, sessionId: message.sessionId });
        this.socket.send(JSON.stringify({ ...message, id, sessionId: message.sessionId ?? client.root }));
      },
      close: async () => {
        if (closed) return;
        closed = true;
        trace('client.release', { clients: this.clients.size });
        this.clients.delete(client);
        for (const [session, owner] of this.sessions) if (owner === client) this.sessions.delete(session);
        for (const [id, pending] of this.pending) if (pending.kind === 'client' && pending.client === client) this.pending.delete(id);
        if (this.clients.size === 0) await this.close();
        else if (!this.retiring) {
          const detached = await this.command('Target.detachFromTarget', { sessionId: client.root });
          if (detached.error) throw new Error('Agent Computer browser did not detach a CDP session');
        }
      },
    };
  }

  private receive(message: CdpMessage): void {
    if (message.id !== undefined) {
      this.receiveResponse(message, message.id);
      return;
    }
    const client = message.sessionId === undefined ? undefined : this.sessions.get(message.sessionId);
    if (!client) return;
    const child = message.params?.sessionId;
    if (typeof child === 'string') {
      if (message.method === 'Target.attachedToTarget') this.sessions.set(child, client);
      if (message.method === 'Target.detachedFromTarget') this.sessions.delete(child);
    }
    if (message.sessionId === client.root) delete message.sessionId;
    client.message(message);
  }

  private receiveResponse(message: CdpMessage, id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.kind === 'internal') {
      pending.resolve(message);
      return;
    }
    if (!this.clients.has(pending.client)) return;
    const result = message.result as { sessionId?: string } | undefined;
    if (typeof result?.sessionId === 'string') this.sessions.set(result.sessionId, pending.client);
    if (pending.id === undefined) delete message.id;
    else message.id = pending.id;
    if (pending.sessionId === undefined) delete message.sessionId;
    else message.sessionId = pending.sessionId;
    pending.client.message(message);
  }

}

export function sharedCdpTransport({ open, claim }: {
  open(accountId: string, browserSessionId: string): Promise<{ endpoint: string; headers: Record<string, string> }>;
  claim(accountId: string, browserSessionId: string, letGo: () => Promise<void>): (() => void) | null;
}) {
  const transports = new Map<string, Promise<Transport>>();

  async function start(accountId: string, browserSessionId: string, trace: ComputerTrace): Promise<Transport> {
    const reference = traceReference();
    const parent = trace;
    trace = (event, fields) => parent(event, { ...fields, transport: reference });
    trace('upstream.descriptor-start');
    const { endpoint, headers } = await open(accountId, browserSessionId);
    trace('upstream.descriptor-ready', { secure: new URL(endpoint).protocol === 'wss:' });
    let transport: Transport;
    const release = claim(accountId, browserSessionId, () => transport.close());
    trace('claim.result', { accepted: release !== null });
    if (release === null) throw new Error('Agent Computer browser closed');
    try {
      transport = new Transport(traceSocket(trace, () => new WebSocket(endpoint, { headers } as unknown as string[])), release, trace, reference);
    } catch (error) {
      release();
      throw error;
    }
    return transport;
  }

  function get(accountId: string, browserSessionId: string, trace: ComputerTrace): Promise<Transport> {
    const key = JSON.stringify([accountId, browserSessionId]);
    const existing = transports.get(key);
    trace('registry.lookup', { reused: existing !== undefined });
    if (existing) return existing;
    const opening = start(accountId, browserSessionId, trace);
    transports.set(key, opening);
    const remove = () => {
      if (transports.get(key) === opening) { trace('registry.remove'); transports.delete(key); }
    };
    void opening.then((transport) => { void transport.ended.then(remove); }, remove);
    return opening;
  }

  async function connect(accountId: string, browserSessionId: string, listener: Listener, trace: ComputerTrace = () => {}): Promise<CdpChannel> {
    const transport = await get(accountId, browserSessionId, trace);
    trace('registry.ready', { transport: transport.reference });
    await transport.opened();
    if (transport.retiring) {
      await transport.ended;
      return connect(accountId, browserSessionId, listener, trace);
    }
    return transport.join(listener, trace);
  }

  return { connect };
}
