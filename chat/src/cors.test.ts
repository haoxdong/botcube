import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { LOCAL_UI_ORIGINS } from './cors.js';

const UI = 'https://ui.example.com';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ config: { corsOrigins: [UI] } });
});
afterAll(() => stack.stop());

const preflight = (origin: string, headers: Record<string, string> = {}) =>
  stack.app.request('/threads', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', ...headers },
  });

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));
  return headers;
}

describe('a CORS preflight', () => {
  it('allows an allowed origin with credentials and the headers it asks for', async () => {
    const response = await preflight(UI, { 'access-control-request-headers': 'content-type, x-trace' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(headersOf(response)).toEqual({
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type, x-trace',
      'access-control-allow-methods': 'DELETE, GET, PATCH, POST, PUT, OPTIONS',
      'access-control-allow-origin': UI,
      'access-control-max-age': '600',
      'content-type': 'text/plain;charset=UTF-8',
      vary: 'Origin',
    });
  });

  it('refuses a disallowed origin without granting it access', async () => {
    const response = await preflight('https://evil.example.com', { 'access-control-request-headers': 'content-type' });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Disallowed CORS origin');
    expect(headersOf(response)).toEqual({
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'DELETE, GET, PATCH, POST, PUT, OPTIONS',
      'access-control-max-age': '600',
      'content-type': 'text/plain;charset=UTF-8',
      vary: 'Origin',
    });
  });

  it('allows no request headers it was not asked for', async () => {
    const response = await preflight(UI);

    expect(response.status).toBe(200);
    expect(response.headers.has('access-control-allow-headers')).toBe(false);
  });
});

describe('a request that is not a CORS preflight', () => {
  it('is an OPTIONS request without an origin, which reaches the routes', async () => {
    const response = await stack.app.request('/ping', {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'GET' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.has('access-control-allow-methods')).toBe(false);
  });

  it('is an OPTIONS request without a requested method, which reaches the routes', async () => {
    const response = await stack.app.request('/ping', { method: 'OPTIONS', headers: { origin: UI } });

    expect(response.status).toBe(404);
    expect(response.headers.has('access-control-allow-methods')).toBe(false);
  });

  it('is any other method, even with preflight headers', async () => {
    const response = await stack.app.request('/ping', {
      headers: { origin: UI, 'access-control-request-method': 'GET' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'Healthy' });
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

  it('from a disallowed origin gets no access', async () => {
    const response = await stack.app.request('/ping', { headers: { origin: 'https://evil.example.com' } });

    expect(response.status).toBe(200);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    expect(response.headers.has('vary')).toBe(false);
  });

  it('without an origin gets no CORS headers', async () => {
    const response = await stack.app.request('/ping');

    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.has('vary')).toBe(false);
  });
});

describe('the allowed origins', () => {
  it.each(['http://localhost:3001', 'http://127.0.0.1:3001'])(
    'include the local web UI at %s for a Cartridge that allows it',
    async (origin) => {
      const local = await startInProcess({ cartridge: { corsOrigins: LOCAL_UI_ORIGINS } });
      try {
        const response = await local.app.request('/threads', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        });

        expect(response.status).toBe(200);
      } finally {
        await local.stop();
      }
    },
  );

  it("are the Cartridge's defaults when BOTCUBE_CORS_ORIGINS is unset", async () => {
    const defaults = await startInProcess({ cartridge: { corsOrigins: ['https://cartridge.example.com'] } });
    try {
      const allowed = await defaults.app.request('/ping', { headers: { origin: 'https://cartridge.example.com' } });
      const other = await defaults.app.request('/ping', { headers: { origin: UI } });

      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://cartridge.example.com');
      expect(other.headers.has('access-control-allow-origin')).toBe(false);
    } finally {
      await defaults.stop();
    }
  });

  it("replace the Cartridge's defaults when BOTCUBE_CORS_ORIGINS is set", async () => {
    const overridden = await startInProcess({
      cartridge: { corsOrigins: ['https://cartridge.example.com'] },
      config: { corsOrigins: [UI] },
    });
    try {
      const response = await overridden.app.request('/ping', {
        headers: { origin: 'https://cartridge.example.com' },
      });

      expect(response.headers.has('access-control-allow-origin')).toBe(false);
    } finally {
      await overridden.stop();
    }
  });
});
