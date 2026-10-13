import { randomUUID } from 'node:crypto';
import { awsFetch, signedAwsHeaders } from './aws.js';
import { Cdp } from './cdp.js';
export interface AgentCoreBrowser { region: string; endpoint: string; browserId: string; }
export interface StartedBrowserSession { sessionId: string; expiresAt: number; }
/** The AgentCore browser-session API and its CDP automation streams, signed by the Chat Service's AWS credentials. */
export class BrowserSessions {
  private readonly automationStreams = new Map<string, string>();

  constructor(readonly config: AgentCoreBrowser) {}

  async call(method: string, path: string, { query, body }: { query?: Record<string, string>; body?: object } = {}) {
    const url = new URL(`${this.config.endpoint}/browsers/${encodeURIComponent(this.config.browserId)}/sessions/${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const response = await awsFetch('bedrock-agentcore', this.config.region, url.toString(), {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AgentCore browser ${path} returned HTTP ${response.status}: ${text}`);
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** Start a browser Session; answers its ID and the deadline from its AgentCore creation timestamp. */
  async start(body: Record<string, unknown> & { sessionTimeoutSeconds: number }): Promise<StartedBrowserSession> {
    const response = await this.call('PUT', 'start', { body: { ...body, clientToken: randomUUID() } });
    const sessionId = requireString(response.sessionId, 'sessionId');
    const createdAt = Date.parse(requireString(response.createdAt, 'createdAt')) / 1000;
    if (!Number.isFinite(createdAt)) throw new Error('AgentCore browser session response has an invalid createdAt');
    this.automationStreams.set(sessionId, automationStreamEndpoint(response));
    return { sessionId, expiresAt: createdAt + body.sessionTimeoutSeconds };
  }

  stop(sessionId: string) {
    this.automationStreams.delete(sessionId);
    return this.call('PUT', 'stop', { query: { sessionId }, body: { clientToken: randomUUID() } });
  }

  private async streamEndpoint(sessionId: string): Promise<string> {
    const known = this.automationStreams.get(sessionId);
    if (known) return known;
    const endpoint = automationStreamEndpoint(await this.call('GET', 'get', { query: { sessionId } }));
    this.automationStreams.set(sessionId, endpoint);
    return endpoint;
  }

  /** Whether a browser Session's automation stream is ENABLED, or DISABLED while the user has taken it over. */
  async automationStreamStatus(sessionId: string): Promise<string> {
    const streams = (await this.call('GET', 'get', { query: { sessionId } })).streams as
      | { automationStream?: { streamStatus?: unknown } | null }
      | null
      | undefined;
    return requireString(streams?.automationStream?.streamStatus, 'streamStatus');
  }

  /** Turn a browser Session's automation stream on, or off while the user takes it over. */
  updateAutomationStream(sessionId: string, streamStatus: 'ENABLED' | 'DISABLED') {
    return this.call('PUT', 'streams/update', {
      query: { sessionId },
      body: { streamUpdate: { automationStreamUpdate: { streamStatus } }, clientToken: randomUUID() },
    });
  }

  /** A browser Session's automation stream, with the SigV4 headers that open it. */
  async automationStream(sessionId: string): Promise<{ endpoint: string; headers: Record<string, string> }> {
    const endpoint = await this.streamEndpoint(sessionId);
    const headers = await signedAwsHeaders('bedrock-agentcore', this.config.region, {
      method: 'GET',
      // Stryker disable next-line Regex: SigV4 signs the host and path, never the scheme
      url: endpoint.replace(/^wss:\/\//, 'https://'),
    });
    return { endpoint, headers };
  }

  /** Drive a browser Session over its automation stream. */
  async withBrowser<T>(sessionId: string, body: (cdp: Cdp) => Promise<T>): Promise<T> {
    const { endpoint, headers } = await this.automationStream(sessionId);
    const cdp = await Cdp.connect(endpoint, headers);
    try {
      return await body(cdp);
    } finally {
      cdp.close();
    }
  }
}

function automationStreamEndpoint(response: Record<string, unknown>): string {
  const streams = response.streams as { automationStream?: { streamEndpoint?: unknown } | null } | null | undefined;
  if (typeof streams !== 'object' || streams === null) {
    throw new Error('AgentCore browser session response missing streams');
  }
  if (typeof streams.automationStream !== 'object' || streams.automationStream === null) {
    throw new Error('AgentCore browser session response missing automation stream');
  }
  return requireString(streams.automationStream.streamEndpoint, 'streamEndpoint');
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`AgentCore browser session response missing ${name}`);
  return value;
}
