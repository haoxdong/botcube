import { describe, expect, it } from 'vitest';

// @ts-expect-error -- the Worker is plain JavaScript uploaded as-is by handler.py.
import worker from './parked-worker.mjs';

const env = { ALLOWED_ORIGINS: JSON.stringify(['https://bot-cube.com', 'http://localhost:3001']) };

describe('parked Worker', () => {
  it('answers every request with the parked 503 readable by the web UI', async () => {
    const response = await worker.fetch(new Request('https://api.bot-cube.com/account/session', {
      headers: { Origin: 'https://bot-cube.com' },
    }), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'parked' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://bot-cube.com');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers a credentialed preflight so the browser sends the real request', async () => {
    const response = await worker.fetch(new Request('https://api.bot-cube.com/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3001',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('DELETE, GET, POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('content-type');
  });

  it('grants no CORS access to other origins', async () => {
    const response = await worker.fetch(new Request('https://api.bot-cube.com/health', {
      headers: { Origin: 'https://evil.example' },
    }), env);

    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
