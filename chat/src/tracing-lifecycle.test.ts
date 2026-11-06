import { defined } from '../test/defined.js';
import { once } from 'node:events';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatServiceCartridge } from './cartridge.js';
import type { TaskStopSleep } from './task-stop.js';
import { serveChatService } from './server.js';
import { reportUnsavedTurnSummaries } from './turn-summaries.js';

const lifecycle = vi.hoisted(() => ({ shutdown: vi.fn<() => Promise<void>>(), stop: undefined as (() => TaskStopSleep) | undefined }));
vi.mock('./tracing.js', () => ({ startChatTracing: () => ({ shutdown: lifecycle.shutdown }) }));
vi.mock('./task-stop.js', () => ({ sleepComputersAtTaskStop: (stop: () => TaskStopSleep) => { lifecycle.stop = stop; return () => undefined; } }));
afterEach(() => {
  vi.restoreAllMocks();
  process.off('exit', reportUnsavedTurnSummaries);
});

const cartridge: ChatServiceCartridge = {
  corsOrigins: [], agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
  models: [{ key: 'test', label: 'Test', provider: 'test' }], accountModels: async () => [], accountModel: async () => undefined,
  routes: new Hono(), requester: async () => ({ owner: 'owner' }),
  filingUserId: (owner) => owner, scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null, invocationPayload: async (input) => ({ ...input, forwardedProps: input.forwardedProps ?? {} }),
  credentialProps: [], authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined,
};

it.each([false, true])('waits for the single tracing shutdown before task-stop settles with failure %s', async (failure) => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const flushed = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  lifecycle.shutdown.mockReset().mockReturnValue(flushed);
  const server = serveChatService(() => cartridge, { PORT: '0', BOTCUBE_CHAT_HOST: '127.0.0.1', BOTCUBE_CHAT_TABLE: 'trace-test' });
  await once(server, 'listening');
  const closed = once(server, 'close');
  const stop = defined(lifecycle.stop, 'task-stop callback')();
  const result = Promise.allSettled([stop.slept, ...stop.sleeps]);
  let settled = false;
  void result.then(() => { settled = true; });
  await closed;
  expect(lifecycle.shutdown).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  if (failure) defined(reject, 'shutdown rejection')(new Error('export failed'));
  else defined(resolve, 'shutdown completion')();
  const outcomes = await result;
  expect(outcomes.map((outcome) => outcome.status)).toEqual(failure ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
  expect(lifecycle.shutdown).toHaveBeenCalledTimes(1);
  expect(process.listeners('exit')).toContain(reportUnsavedTurnSummaries);
});
