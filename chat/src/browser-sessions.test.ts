import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSessionEnded, BrowserSessions } from './browser-sessions.js';

const sessions = () => new BrowserSessions({ region: 'us-east-1', endpoint: 'https://agentcore.test', browserId: 'browser-id' });

beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Production, 2026-10-24 19:09Z: AgentCore answered an expired sign-in browser's stop with 409 "Session already
// terminated", so starting a new sign-in returned 500 while the abandoned one's browser could not be stopped.
it.each([
  [404, '{"message":"ResourceNotFoundException"}'],
  [409, 'Session already terminated'],
])('reports a stop answered HTTP %s as an ended session', async (status, body) => {
  vi.stubGlobal('fetch', async () => new Response(body, { status }));
  await expect(sessions().stop('browser-1')).rejects.toBeInstanceOf(BrowserSessionEnded);
});

it('keeps any other conflict on stop a failure', async () => {
  vi.stubGlobal('fetch', async () => new Response('Session is starting', { status: 409 }));
  const stopped = sessions().stop('browser-1');
  await expect(stopped).rejects.toThrow('AgentCore browser stop returned HTTP 409: Session is starting');
  await expect(stopped).rejects.not.toBeInstanceOf(BrowserSessionEnded);
});
