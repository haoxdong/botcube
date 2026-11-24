import { describe, expect, it, vi } from 'vitest';
import { relayTurn } from './turn-stream.js';
import { purgeQueue } from './purges.js';
import { runRuntimeWriter } from './session-writer-runtime.js';
import { SessionWriters } from './session-writers.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { runtimeSessionId, sessionLifecycle } from './session-lifecycle.js';
import type { Upstream } from './upstream.js';

const SESSION = { session_id: 'session', filing_user_id: 'filing-user' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Session deletion dispatch barrier', () => {
  it('terminates automatic purge retries when a durable rejected writer keeps answering absent', async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const complete = Object.assign(vi.fn(async () => undefined), { session: SESSION, token: 'failed-token' });
      const stop = vi.fn<() => Promise<void | 'absent'>>().mockResolvedValue('absent');
      const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke: async () => new Response() }, stop);
      let rejected = [complete];
      complete.mockImplementation(async () => { rejected = []; });
      const writers = new SessionWriters('chat', DynamoDBDocumentClient.from(new DynamoDBClient({})));
      vi.spyOn(writers, 'settleExpired').mockResolvedValue(undefined);
      vi.spyOn(writers, 'rejectedDispatches').mockImplementation(async (session) => session === SESSION ? rejected : []);
      vi.spyOn(writers, 'assertNoDispatch').mockResolvedValue(undefined);
      const erase = vi.fn(async () => ({}));
      const purged = vi.fn(async () => undefined);
      const purge = purgeQueue(erase, (owner) => owner, (session) => writers.stopAfterWriters(session, lifecycle, false), undefined, purged);
      purge([SESSION]);
      await vi.advanceTimersByTimeAsync(155_000);
      expect(stop).toHaveBeenCalledTimes(4);
      expect(logged).toHaveBeenCalledOnce();
      expect(logged.mock.calls[0]?.[1]).toMatchObject({ status: 503, code: 'RUNTIME_ADMISSION_UNPROVED' });

      purge([SESSION]);
      await vi.advanceTimersByTimeAsync(275_000);
      expect(stop).toHaveBeenCalledTimes(4);
      expect(logged).toHaveBeenCalledOnce();
      expect(erase).not.toHaveBeenCalled();
      expect(purged).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      await expect(lifecycle.invokeRegistered('{}', SESSION, complete)).rejects.toMatchObject({ status: 410 });

      const unrelated = { ...SESSION, session_id: 'unrelated' };
      purge([unrelated]);
      await vi.advanceTimersByTimeAsync(0);
      expect(erase).toHaveBeenCalledExactlyOnceWith('purge', { sessionId: 'unrelated', userId: 'filing-user' });
      expect(purged).toHaveBeenCalledExactlyOnceWith(unrelated);

      stop.mockResolvedValueOnce(undefined);
      await purge.wait([SESSION]);
      expect(erase).toHaveBeenLastCalledWith('purge', { sessionId: 'session', userId: 'filing-user' });
      expect(purged).toHaveBeenLastCalledWith(SESSION);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('keeps a Runtime persistence writer registered after headers until producer EOF', async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const complete = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { producer = controller; },
    })) }, async () => undefined);
    const response = await lifecycle.invokeRegistered('{}', SESSION, complete);
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    const answer = response.text();
    producer.close();
    await answer;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('drains a disconnected Runtime consumer until producer EOF before releasing its writer', async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const complete = vi.fn(async () => undefined);
    const cancelled = vi.fn();
    const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { producer = controller; }, cancel: cancelled,
    })) }, async () => undefined);
    const response = await lifecycle.invokeRegistered('{}', SESSION, complete);
    const disconnected = response.body?.cancel();
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
    producer.close();
    await disconnected;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('keeps an admission unclassified when its durable rejection write fails', async () => {
    const complete = Object.assign(vi.fn(async () => undefined), { markRejected: async () => { throw new Error('classification unavailable'); } });
    const stop = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'configured-runtime', invoke: async () => { throw new Error('headers lost'); } }, stop);
    await expect(runRuntimeWriter(async () => complete, { timeoutMs: 0 }, lifecycle, SESSION, ({ invoke }) => invoke('{}', SESSION.session_id))).rejects.toThrow('durable rejection classification failed');
    expect(stop).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([false, true])('recovers an admitted header acknowledgement failure only after exact successful stop (empty body: %s)', async (empty) => {
    const ackError = new Error('durable acknowledgement unavailable');
    const complete = Object.assign(vi.fn<() => Promise<void>>().mockRejectedValueOnce(ackError).mockResolvedValue(undefined), {
      session: SESSION, token: 'exact-header-token', markRejected: vi.fn(async () => undefined), confirmStopped: vi.fn(async () => undefined),
    });
    const stop = vi.fn<() => Promise<void | 'absent'>>().mockRejectedValueOnce(new Error('Runtime stop failed')).mockResolvedValueOnce('absent').mockResolvedValueOnce(undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'authoritative-runtime', invoke: async () => new Response(empty ? null : 'admitted body') }, stop);
    const answer = runRuntimeWriter(async () => complete, { timeoutMs: 0 }, lifecycle, SESSION, ({ invoke }) => invoke('{}', SESSION.session_id));
    if (empty) await expect(answer).rejects.toBe(ackError);
    else await expect((await answer).text()).rejects.toBe(ackError);
    expect(complete.markRejected).toHaveBeenCalledWith('authoritative-runtime');
    const writers = new SessionWriters('chat', DynamoDBDocumentClient.from(new DynamoDBClient({})));
    vi.spyOn(writers, 'settleExpired').mockResolvedValue(undefined);
    vi.spyOn(writers, 'rejectedDispatches').mockResolvedValue([complete]);
    vi.spyOn(writers, 'assertNoDispatch').mockResolvedValue(undefined);
    const recover = () => writers.stopAfterWriters(SESSION, lifecycle, false);
    await expect(recover()).rejects.toThrow('Runtime stop failed');
    await expect(recover()).rejects.toMatchObject({ code: 'RUNTIME_ADMISSION_UNPROVED', });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.confirmStopped).not.toHaveBeenCalled();
    await expect(recover()).resolves.toBeUndefined();
    expect(stop).toHaveBeenLastCalledWith(SESSION.session_id);
    expect(complete.confirmStopped).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('preserves original acknowledgement and failed classification without inventing a recovered admission', async () => {
    const ackError = new Error('durable acknowledgement unavailable');
    const classifyError = new Error('durable classification unavailable');
    const complete = Object.assign(vi.fn(async () => { throw ackError; }), { markRejected: vi.fn(async () => { throw classifyError; }) });
    const stop = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'authoritative-runtime', invoke: async () => new Response('admitted body') }, stop);
    const response = await runRuntimeWriter(async () => complete, { timeoutMs: 0 }, lifecycle, SESSION, ({ invoke }) => invoke('{}', SESSION.session_id));
    await expect(response.text()).rejects.toMatchObject({ errors: [ackError, classifyError] });
    expect(stop).not.toHaveBeenCalled();
  });

  it('waits for an already dispatched invocation to answer before stopping its Sandbox', async () => {
    const headers = deferred<Response>();
    const invoke = vi.fn(() => headers.promise);
    const stop = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke }, stop);
    const turn = lifecycle.invokeRegistered('{}', SESSION, async () => undefined);
    lifecycle.fence([SESSION]);
    const stopped = lifecycle.stop(SESSION);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    // A Turn whose recordTurn completed before deletion cannot dispatch after the stop.
    await expect(lifecycle.invokeRegistered('{}', SESSION, async () => undefined)).rejects.toMatchObject({ status: 410 });
    expect(invoke).toHaveBeenCalledTimes(1);
    headers.resolve(new Response('active producer'));
    await turn;
    await stopped;
    expect(stop).toHaveBeenCalledWith(SESSION.session_id);
  });

  it('keeps local dispatch registered after consumer closure until producer EOF', async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const complete = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({
      label: 'local',
      invoke: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { producer = controller; },
      })),
    });
    const response = await lifecycle.invokeRegistered('{}', SESSION, complete);
    const stopped = lifecycle.stop(SESSION);
    await response.text();
    expect(complete).not.toHaveBeenCalled();
    producer.close();
    await stopped;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('preserves demand while a local producer is serving a slow client', async () => {
    let reads = 0;
    const lifecycle = sessionLifecycle({
      label: 'local',
      invoke: async () => new Response(new ReadableStream({ pull(controller) { reads += 1; controller.enqueue(new Uint8Array([reads])); } })),
    });
    const response = await lifecycle.invokeRegistered('{}', SESSION, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBeLessThanOrEqual(2);
    // Terminate the synthetic stream without an infinite deletion drain.
    expect(response.status).toBe(200);
  });
  it('relays a received frame before delayed admission acknowledgement and a socket failure', async () => {
    const acknowledgement = deferred<void>();
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const first = 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hello"}\n\n';
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { producer = controller; controller.enqueue(new TextEncoder().encode(first)); },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    }, async () => undefined);
    const response = relayTurn({
      label: lifecycle.label,
      invoke: (body, _sessionId, init) => lifecycle.invokeRegistered(body, SESSION, () => acknowledgement.promise, init),
    }, { body: '{}', sessionId: 'session', saveAgentDocumentEdit: async () => undefined, finished: async () => undefined, failed: async () => undefined, ended: async () => undefined, started: async () => undefined, credentials: [] });

    // The acknowledgement stays pending while the producer drops after sending its first frame.
    await new Promise((resolve) => setTimeout(resolve, 0));
    producer.error(new Error('producer socket terminated'));
    acknowledgement.resolve();
    const text = await (await response).text();
    expect(text.startsWith(first)).toBe(true);
    expect(text).toContain('AGENTCORE_UPSTREAM_STREAM_ERROR');
  });

  it('reports an admission acknowledgement failure through the stream and retains its deletion blocker', async () => {
    const acknowledgement = deferred<void>();
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => new Response('settled producer'),
    }, async () => 'absent');
    const response = relayTurn({
      label: lifecycle.label,
      invoke: (body, _sessionId, init) => lifecycle.invokeRegistered(body, SESSION, () => acknowledgement.promise, init),
    }, { body: '{}', sessionId: 'session', saveAgentDocumentEdit: async () => undefined, finished: async () => undefined, failed: async () => undefined, ended: async () => undefined, started: async () => undefined, credentials: [] });

    await new Promise((resolve) => setTimeout(resolve, 0));
    acknowledgement.reject(new Error('admission acknowledgement failed'));
    const opened = await response;
    expect(opened.status).toBe(200);
    const text = await opened.text();
    expect(text).toContain('AGENTCORE_UPSTREAM_STREAM_ERROR');
    expect(text).toContain('admission acknowledgement failed');
  });

  it('preserves backpressure while an AWS admission acknowledgement is pending', async () => {
    const acknowledgement = deferred<void>();
    let reads = 0;
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { producer = controller; },
        pull(controller) { reads += 1; controller.enqueue(new Uint8Array([reads])); },
      })),
    }, async () => undefined);
    const response = await lifecycle.invokeRegistered('{}', SESSION, () => acknowledgement.promise);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBeLessThanOrEqual(2);
    acknowledgement.resolve();
    producer.close();
    await response.body?.cancel();
  });

  it('retains a settled producer registration when its acknowledgement fails', async () => {
    const ackError = new Error('admission acknowledgement failed');
    const complete = Object.assign(vi.fn(async () => { throw ackError; }), {
      session: SESSION, token: 'settled-token', markRejected: vi.fn(async () => undefined),
    });
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'configured-runtime',
      invoke: async () => new Response('settled producer') }, async () => 'absent');
    const response = await runRuntimeWriter(async () => complete, { timeoutMs: 0 }, lifecycle, SESSION, ({ invoke }) => invoke('{}', SESSION.session_id));
    await expect(response.text()).rejects.toBe(ackError);
    expect(complete.markRejected).toHaveBeenCalledWith('configured-runtime');
  });

  it('keeps another filing identity with the same client Session ID dispatchable after deletion', async () => {
    const upstream: Upstream = { label: 'AgentCore upstream', invoke: vi.fn(async () => new Response('answer')) };
    const lifecycle = sessionLifecycle(upstream, async () => undefined);
    const aliceBody = JSON.stringify({ forwardedProps: { sessionUserId: 'filing-alice' } });
    const bobBody = JSON.stringify({ forwardedProps: { sessionUserId: 'filing-bob' } });
    const alice = { session_id: 'shared-session-id', filing_user_id: 'filing-alice' };
    const bob = { session_id: 'shared-session-id', filing_user_id: 'filing-bob' };
    await lifecycle.invokeRegistered(aliceBody, alice, async () => undefined);
    await lifecycle.invokeRegistered(bobBody, bob, async () => undefined);
    lifecycle.fence([alice]);

    await expect(lifecycle.invokeRegistered(aliceBody, alice, async () => undefined)).rejects.toMatchObject({ status: 410 });
    await expect(lifecycle.invokeRegistered(bobBody, bob, async () => undefined)).resolves.toMatchObject({ status: 200 });
  });

  it('drains only the deleted filing identity while another local producer keeps streaming', async () => {
    const alice = { session_id: 'shared-session-id', filing_user_id: 'filing-alice' };
    const bob = { session_id: 'shared-session-id', filing_user_id: 'filing-bob' };
    const producers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const lifecycle = sessionLifecycle({
      label: 'local',
      invoke: async (body) => new Response(new ReadableStream<Uint8Array>({
        start(controller) { producers.set(body, controller); },
      })),
    });
    const aliceResponse = await lifecycle.invokeRegistered('alice', alice, async () => undefined);
    const bobResponse = await lifecycle.invokeRegistered('bob', bob, async () => undefined);
    const stopping = lifecycle.stop(alice);
    producers.get('bob')?.enqueue(new TextEncoder().encode('bob answer'));
    producers.get('bob')?.close();
    expect(await bobResponse.text()).toBe('bob answer');
    producers.get('alice')?.close();
    await stopping;
    expect(await aliceResponse.text()).toBe('');
  });

});

it('runs and stops every chat in the Sandbox named by its Session ID', () => {
  expect(runtimeSessionId(SESSION)).toBe(SESSION.session_id);
});
