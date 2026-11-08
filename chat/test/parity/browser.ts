/** A browser tab against the Chat Service: it keeps the cookies the service sets. */
export class Browser {
  readonly cookies = new Map<string, string>();
  /** Raw Set-Cookie headers of the last response. */
  lastSetCookies: string[] = [];

  constructor(private readonly baseUrl: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
      );
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
    this.lastSetCookies = response.headers.getSetCookie();
    for (const setCookie of this.lastSetCookies) {
      const [pair = '', ...attributes] = setCookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request(path, init);
  }

  post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
    return this.request(path, {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(body),
    });
  }

  delete(path: string): Promise<Response> {
    return this.request(path, { method: 'DELETE' });
  }

  /** Open the Account session, as the UI does on load. */
  async openAccountSession(): Promise<{ accountId: string; status: string; authenticated: boolean }> {
    const response = await this.get('/account/session');
    if (response.status !== 200) {
      throw new Error(`GET /account/session: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { accountId: string; status: string; authenticated: boolean };
  }

  /** Allocate a Side Chat (`POST /threads`), as the UI does before its first Turn, and return its Session ID. */
  async newSideChat(): Promise<string> {
    const response = await this.request('/threads', { method: 'POST' });
    if (response.status !== 201) throw new Error(`POST /threads: ${response.status} ${await response.text()}`);
    return ((await response.json()) as { id: string }).id;
  }

  /** Send one Turn (`POST /`) and return the response. */
  sendTurn(threadId: string, options: { text?: string; forwardedProps?: object } = {}): Promise<Response> {
    return this.post('/', runAgentInput(threadId, options), {
      headers: { accept: 'text/event-stream' },
    });
  }


}

function runAgentInput(
  threadId: string,
  { text = 'hello', forwardedProps = {} }: { text?: string; forwardedProps?: object } = {}
) {
  return {
    threadId,
    runId: `${threadId}-run`,
    state: {},
    messages: [{ id: `${threadId}-message`, role: 'user', content: text }],
    tools: [],
    context: [],
    forwardedProps,
  };
}

/** Split an SSE body into its frames (the text between blank lines). */
export function sseFrames(body: string): string[] {
  return body.split('\n\n').filter((frame) => frame !== '');
}

/** The JSON `data:` of an SSE frame. */
export function frameData(frame: string): Record<string, unknown> {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('\n');
  return JSON.parse(data) as Record<string, unknown>;
}
