import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { LOCAL_UI_ORIGINS } from './config.js';

const UI = 'https://ui.example.com';
const domains = { web: UI, chatService: 'https://chat.example.com' };

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ botcube: { domains } });
});
afterAll(() => stack.stop());

const preflight = (origin: string, headers: Record<string, string> = {}) =>
  stack.app.request('/threads', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', ...headers },
  });

describe('a CORS preflight', () => {
  it('allows an allowed origin with credentials and the headers it asks for', async () => {
    const response = await preflight(UI, { 'access-control-request-headers': 'content-type, x-trace' });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe(UI);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')?.split(',')).toEqual(['content-type', 'x-trace']);
    expect(response.headers.get('access-control-allow-methods')?.split(',')).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT', 'OPTIONS']);
    expect(response.headers.get('access-control-max-age')).toBe('600');
    expect(response.headers.get('vary')?.split(', ')).toEqual(['Origin', 'Access-Control-Request-Headers']);
  });

  it('denies browser access to a disallowed origin', async () => {
    const response = await preflight('https://evil.example.com', { 'access-control-request-headers': 'content-type' });

    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('allows no request headers it was not asked for', async () => {
    const response = await preflight(UI);

    expect(response.status).toBe(204);
    expect(response.headers.has('access-control-allow-headers')).toBe(false);
  });
});

describe('a cross-origin request', () => {
  it('from an allowed origin gets credentialed access to the response', async () => {
    const response = await stack.app.request('/ping', { headers: { origin: UI } });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(UI);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  // Cloudflare replaces an origin's 502 with its own page, without these headers.
  it('from an allowed origin reads a failed warmup as 503, with credentialed access', async () => {
    await stack.allocate('acct_account-1', 'cors-warmup');
    stack.agentcore.script('cors-warmup', { kind: 'stream', frames: ['data: {"type":"RUN_ERROR","message":"Files could not be mounted","code":"FILES_MOUNT"}'] });

    const response = await stack.app.request('/warmup', {
      method: 'POST',
      headers: { origin: UI, 'content-type': 'application/json' },
      body: '{"threadId":"cors-warmup"}',
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe(UI);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: 'Files could not be mounted' });
  });

  it('from a disallowed origin gets no access', async () => {
    const response = await stack.app.request('/ping', { headers: { origin: 'https://evil.example.com' } });

    expect(response.status).toBe(200);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('without an origin still varies by Origin for shared caches', async () => {
    const response = await stack.app.request('/ping');

    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.get('vary')).toBe('Origin');
  });
});

describe('the allowed origins', () => {
  it.each(LOCAL_UI_ORIGINS)('are the local web UI, %s, when the BotCube Config names it', async (origin) => {
    const local = await startInProcess();
    try {
      const response = await local.app.request('/threads', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      const other = await local.app.request('/ping', { headers: { origin: UI } });

      expect(response.status).toBe(204);
      expect(other.headers.has('access-control-allow-origin')).toBe(false);
    } finally {
      await local.stop();
    }
  });

  it("are the BotCube Config's domains.web and its aliases, and not the local web UI", async () => {
    const aliased = await startInProcess({ botcube: { domains: { ...domains, webAliases: ['https://www.ui.example.com'] } } });
    try {
      const allowed = async (origin: string) =>
        (await aliased.app.request('/ping', { headers: { origin } })).headers.get('access-control-allow-origin');

      expect(await allowed(UI)).toBe(UI);
      expect(await allowed('https://www.ui.example.com')).toBe('https://www.ui.example.com');
      expect(await allowed('http://localhost:3001')).toBeNull();
    } finally {
      await aliased.stop();
    }
  });
});
