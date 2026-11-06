import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- the Worker is plain JavaScript uploaded as-is by handler.py.
import worker from './parked-worker.mjs';

const env = { ALLOWED_ORIGINS: JSON.stringify(['https://example.com', 'http://localhost:3001']), WAKE_URL: 'http://127.0.0.1:9/' };

describe('parked Worker', () => {
  it('answers every request with the parked 503 readable by the web UI', async () => {
    const response = await worker.fetch(new Request('https://api.example.com/account/session', {
      headers: { Origin: 'https://example.com' },
    }), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'parked' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers a credentialed preflight so the browser sends the real request', async () => {
    const response = await worker.fetch(new Request('https://api.example.com/chat', {
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
    const response = await worker.fetch(new Request('https://api.example.com/health', {
      headers: { Origin: 'https://evil.example' },
    }), env);

    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it.each(['GET', 'POST'])('passes a %s of the paused page\'s Wake up to the parking Lambda, readable by the web UI', async (method) => {
    const seen: string[] = [];
    const lambda = createServer((request, response) => {
      seen.push(request.method ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"state":"waking","since":"2026-11-04T05:00:00.000Z"}');
    });
    lambda.listen(0, '127.0.0.1');
    await once(lambda, 'listening');
    try {
      const address = lambda.address();
      if (address === null || typeof address === 'string') throw new Error('Expected an HTTP port');
      const response = await worker.fetch(new Request('https://api.example.com/production/wake', {
        method, headers: { Origin: 'https://example.com' },
      }), { ...env, WAKE_URL: `http://127.0.0.1:${address.port}/` });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: 'waking', since: '2026-11-04T05:00:00.000Z' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(seen).toEqual([method]);
    } finally {
      lambda.close();
    }
  });

  it('answers any other request to the wake path as parked', async () => {
    const response = await worker.fetch(new Request('https://api.example.com/production/wake', { method: 'DELETE' }), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'parked' });
  });
});
