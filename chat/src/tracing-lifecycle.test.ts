import { defined } from '../test/defined.js';
import { once } from 'node:events';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import * as scheduledRuns from './scheduled-runs.js';
import { serveChatService } from './server.js';
import type { StockOverrides } from './stock.js';
import { testBotCubeConfig } from '../test/stock-bot.js';

const lifecycle = vi.hoisted(() => ({ shutdown: vi.fn<() => Promise<void>>() }));
vi.mock('./tracing.js', () => ({ startChatTracing: () => ({ shutdown: lifecycle.shutdown }) }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const overrides: StockOverrides = {
  agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
  models: [{ key: 'test', label: 'Test', provider: 'test' }], accountModels: async () => [],
  routes: new Hono(), requester: async () => ({ owner: 'owner' }),
  filingUserId: (owner) => owner, scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null, invocationPayload: async (input) => ({ ...input, forwardedProps: input.forwardedProps ?? {} }),
  credentialProps: [], authorizeBrowserLiveView: async () => undefined, warmSession: async () => undefined, turnStarting: () => undefined, recoverAccountDeletions: async () => undefined,
};

it.each([
  ['finishes', 'flushes'],
  ['finishes', 'rejects'],
  ['times out', 'flushes'],
  ['times out', 'times out'],
] as const)('exits successfully when the Turn drain %s and tracing %s after the computers sleep', async (drain, tracing) => {
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', 'http://127.0.0.1:1');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const stopScheduledRuns = vi.fn(() => drain === 'times out' ? new Promise<void>(() => {}) : Promise.resolve());
  vi.spyOn(scheduledRuns, 'pollScheduledRuns').mockReturnValue(stopScheduledRuns);
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const flushed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  lifecycle.shutdown.mockReset().mockReturnValue(flushed);
  const previous = process.rawListeners('SIGTERM');
  const server = await serveChatService({
    PORT: '0', BOTCUBE_CHAT_TABLE: 'trace-test', BOTCUBE_CONFIG: testBotCubeConfig(),
    BOTCUBE_SCHEDULE_GROUP: 'test-group',
    BOTCUBE_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
    BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:runs',
    BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/runs',
  }, { overrides: { ...overrides, sleepAgentComputers: () => ({ slept: Promise.resolve(['browser-proven']), sleeps: [] }) } });
  await once(server, 'listening');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const closed = once(server, 'close');
  defined(process.rawListeners('SIGTERM').find((listener) => !previous.includes(listener)), 'Chat SIGTERM handler').call(process);
  await closed;
  await vi.advanceTimersByTimeAsync(drain === 'times out' ? 110_000 : 0);
  expect(stopScheduledRuns).toHaveBeenCalledTimes(1);
  expect(lifecycle.shutdown).toHaveBeenCalledTimes(1);
  expect(exit).not.toHaveBeenCalled();
  if (tracing === 'flushes') finish();
  if (tracing === 'rejects') fail(new Error('export failed'));
  await vi.advanceTimersByTimeAsync(tracing === 'times out' ? 10_000 : 0);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(console.log).toHaveBeenCalledWith('Agent Computers slept at task stop: browser-proven');
  expect(errors.mock.calls.map(([message]) => message)).not.toContain('Agent Computer sleep at task stop failed');
  if (drain === 'times out') expect(errors).toHaveBeenCalledWith('Chat Turn drain failed', expect.any(Error));
  if (tracing !== 'flushes') expect(errors).toHaveBeenCalledWith('Chat tracing shutdown failed', expect.any(Error));
});
