import { describe, expect, it, vi } from 'vitest';
import { relayTurn } from './turn-stream.js';
import { runtimeSessionId, sessionLifecycle } from './session-lifecycle.js';
import type { Upstream } from './upstream.js';

const SESSION = { session_id: 'session', filing_user_id: 'filing-user', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000001' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Session deletion dispatch barrier', () => {
  it('keeps an admission unclassified when its durable rejection write fails', async () => {
    const complete = Object.assign(vi.fn(async () => undefined), { markRejected: async () => { throw new Error('classification unavailable'); } });
    const stop = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'configured-runtime', invoke: async () => { throw new Error('headers lost'); } }, stop);
    await expect(lifecycle.invokeRegistered('{}', SESSION, complete)).rejects.toThrow('durable rejection classification failed');
    expect(lifecycle.failedDispatchTokens(SESSION)).toEqual([]);
    expect(await lifecycle.settleFailedDispatch(SESSION)).toBe(false);
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
    const answer = lifecycle.invokeRegistered('{}', SESSION, complete);
    if (empty) await expect(answer).rejects.toBe(ackError);
    else await expect((await answer).text()).rejects.toBe(ackError);
    expect(complete.markRejected).toHaveBeenCalledWith('authoritative-runtime');
    expect(lifecycle.failedDispatchTokens(SESSION)).toEqual(['exact-header-token']);
    await expect(lifecycle.settleFailedDispatch(SESSION)).rejects.toThrow('Runtime stop failed');
    await expect(lifecycle.settleFailedDispatch(SESSION)).rejects.toBe(ackError);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.confirmStopped).not.toHaveBeenCalled();
    await expect(lifecycle.settleFailedDispatch(SESSION)).resolves.toBe(true);
    expect(stop).toHaveBeenLastCalledWith(SESSION.runtime_binding);
    expect(complete.confirmStopped).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(lifecycle.failedDispatchTokens(SESSION)).toEqual([]);
  });

  it('preserves original acknowledgement and failed classification without inventing a recovered admission', async () => {
    const ackError = new Error('durable acknowledgement unavailable');
    const classifyError = new Error('durable classification unavailable');
    const complete = Object.assign(vi.fn(async () => { throw ackError; }), { markRejected: vi.fn(async () => { throw classifyError; }) });
    const stop = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'authoritative-runtime', invoke: async () => new Response('admitted body') }, stop);
    const response = await lifecycle.invokeRegistered('{}', SESSION, complete);
    await expect(response.text()).rejects.toMatchObject({ errors: [ackError, classifyError] });
    expect(lifecycle.failedDispatchTokens(SESSION)).toEqual([]);
    expect(await lifecycle.settleFailedDispatch(SESSION)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not treat Runtime absence as settlement of a recovered rejected admission', async () => {
    const complete = Object.assign(vi.fn(async () => undefined), { session: SESSION, token: 'rejected-token' });
    const stop = vi.fn(async () => 'absent' as const);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke: async () => new Response() }, stop);
    lifecycle.restoreFailedDispatch(SESSION, [complete]);
    await expect(lifecycle.settleFailedDispatch(SESSION)).rejects.toThrow('settlement is unproved');
    expect(complete).not.toHaveBeenCalled();
    expect(lifecycle.failedDispatchTokens(SESSION)).toEqual(['rejected-token']);
  });

  it('retries a failed admission acknowledgement using its prior exact successful stop', async () => {
    const complete = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('registration delete unavailable'))
      .mockResolvedValueOnce(undefined);
    const stop = vi.fn<() => Promise<void | 'absent'>>().mockResolvedValueOnce(undefined).mockResolvedValue('absent');
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'configured-runtime', invoke: async () => { throw new Error('headers lost'); } }, stop);
    await expect(lifecycle.invokeRegistered('{}', SESSION, complete)).rejects.toThrow('headers lost');
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('registration delete unavailable');
    await expect(lifecycle.stop(SESSION)).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('retains a lost-header admission until its exact Sandbox is successfully stopped', async () => {
    const complete = vi.fn(async () => undefined);
    const stop = vi.fn<() => Promise<void | 'absent'>>()
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce('absent')
      .mockResolvedValueOnce(undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore', runtimeTarget: 'configured-runtime', invoke: async () => { throw new Error('headers lost'); } }, stop);
    await expect(lifecycle.invokeRegistered('{}', SESSION, complete)).rejects.toThrow('headers lost');
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('stop failed');
    expect(complete).not.toHaveBeenCalled();
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('headers lost');
    expect(complete).not.toHaveBeenCalled();
    await lifecycle.stop(SESSION);
    expect(stop).toHaveBeenLastCalledWith(SESSION.runtime_binding);
    expect(complete).toHaveBeenCalledOnce();
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
    expect(stop).toHaveBeenCalledWith('runtime-00000000-0000-4000-8000-000000000001');
  });

  it('does not authorize purge from absence after ambiguous invocation failure', async () => {
    const headers = deferred<Response>();
    const stop = vi.fn(async (): Promise<void | 'absent'> => 'absent');
    const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke: () => headers.promise }, stop);
    const turn = lifecycle.invokeRegistered('{}', SESSION, async () => undefined);
    const rejected = expect(turn).rejects.toThrow('headers lost');
    const stopped = lifecycle.stop(SESSION);
    headers.reject(new Error('headers lost'));
    await rejected;
    await expect(stopped).rejects.toThrow('headers lost');
    expect(stop).toHaveBeenCalledOnce();
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('headers lost');
    stop.mockResolvedValueOnce(undefined);
    await expect(lifecycle.stop(SESSION)).resolves.toBeUndefined();
    await expect(lifecycle.stop(SESSION)).resolves.toBe('absent');
  });

  it('does not report a failed local producer as quiescent on deletion or retries', async () => {
    const upstream: Upstream = {
      label: 'local',
      invoke: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('producer lost')); } })),
    };
    const lifecycle = sessionLifecycle(upstream);
    const response = await lifecycle.invokeRegistered('{}', SESSION, async () => undefined);
    await expect(response.text()).rejects.toThrow('producer lost');
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('producer lost');
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('producer lost');
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
    }, { body: '{}', sessionId: 'session', browserEventName: 'test:live', saveAgentDocumentEdit: async () => undefined, finished: async () => undefined, failed: async () => undefined, ended: async () => undefined, started: async () => undefined, credentials: [] });

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
      invoke: async () => new Response(new ReadableStream<Uint8Array>()),
    }, async () => 'absent');
    const response = relayTurn({
      label: lifecycle.label,
      invoke: (body, _sessionId, init) => lifecycle.invokeRegistered(body, SESSION, () => acknowledgement.promise, init),
    }, { body: '{}', sessionId: 'session', browserEventName: 'test:live', saveAgentDocumentEdit: async () => undefined, finished: async () => undefined, failed: async () => undefined, ended: async () => undefined, started: async () => undefined, credentials: [] });

    await new Promise((resolve) => setTimeout(resolve, 0));
    acknowledgement.reject(new Error('admission acknowledgement failed'));
    const opened = await response;
    expect(opened.status).toBe(200);
    const text = await opened.text();
    expect(text).toContain('AGENTCORE_UPSTREAM_STREAM_ERROR');
    expect(text).toContain('admission acknowledgement failed');
    await expect(lifecycle.stop(SESSION)).rejects.toThrow('admission acknowledgement failed');
  });

  it('preserves backpressure while an AWS admission acknowledgement is pending', async () => {
    const acknowledgement = deferred<void>();
    let reads = 0;
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { reads += 1; controller.enqueue(new Uint8Array([reads])); },
      })),
    }, async () => undefined);
    const response = await lifecycle.invokeRegistered('{}', SESSION, () => acknowledgement.promise);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBeLessThanOrEqual(2);
    acknowledgement.resolve();
    await response.body?.cancel();
  });

  it('allows an absent Sandbox on retry after a successful stop ends its confirmed response stream', async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const stop = vi.fn<() => Promise<void | 'absent'>>()
      .mockResolvedValueOnce(undefined).mockResolvedValue('absent');
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { producer = controller; },
      })),
    }, stop);
    const response = await lifecycle.invokeRegistered('{}', SESSION, async () => undefined);

    await expect(lifecycle.stop(SESSION)).resolves.toBeUndefined();
    // Stopping the known Sandbox terminates its open response after the stop was confirmed.
    producer.error(new Error('stream ended by Runtime stop'));
    await expect(response.text()).rejects.toThrow('stream ended by Runtime stop');
    await expect(lifecycle.stop(SESSION)).resolves.toBe('absent');
  });

  it.each([false, true])('cancels a pending response reader when admission acknowledgement fails (cancel fails: %s)', async (cancelFails) => {
    const acknowledgement = deferred<void>();
    const ackError = new Error('admission acknowledgement failed');
    const cancelError = new Error('upstream response cancellation failed');
    const cancel = vi.fn(async () => { if (cancelFails) throw cancelError; });
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
    }, async () => 'absent');
    const response = await relayTurn({
      label: lifecycle.label,
      invoke: (body, _sessionId, init) => lifecycle.invokeRegistered(body, SESSION, () => acknowledgement.promise, init),
    }, { body: '{}', sessionId: 'session', browserEventName: 'test:live', saveAgentDocumentEdit: async () => undefined, finished: async () => undefined, failed: async () => undefined, ended: async () => undefined, started: async () => undefined, credentials: [] });

    acknowledgement.reject(ackError);
    const text = await response.text();
    expect(cancel).toHaveBeenCalledWith(ackError);
    expect(text).toContain('AGENTCORE_UPSTREAM_STREAM_ERROR');
    if (cancelFails) {
      expect(text).toContain('cancelling the upstream response also failed');
      await expect(lifecycle.stop(SESSION)).rejects.toMatchObject({ errors: [ackError, cancelError] });
    } else {
      expect(text).toContain('admission acknowledgement failed');
      await expect(lifecycle.stop(SESSION)).rejects.toBe(ackError);
    }
  });

  it('keeps another filing identity with the same client Session ID dispatchable after deletion', async () => {
    const upstream: Upstream = { label: 'AgentCore upstream', invoke: vi.fn(async () => new Response('answer')) };
    const lifecycle = sessionLifecycle(upstream, async () => undefined);
    const aliceBody = JSON.stringify({ forwardedProps: { sessionUserId: 'filing-alice' } });
    const bobBody = JSON.stringify({ forwardedProps: { sessionUserId: 'filing-bob' } });
    const alice = { session_id: 'shared-session-id', filing_user_id: 'filing-alice', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000002' };
    const bob = { session_id: 'shared-session-id', filing_user_id: 'filing-bob', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000003' };
    await lifecycle.invokeRegistered(aliceBody, alice, async () => undefined);
    await lifecycle.invokeRegistered(bobBody, bob, async () => undefined);
    lifecycle.fence([alice]);

    await expect(lifecycle.invokeRegistered(aliceBody, alice, async () => undefined)).rejects.toMatchObject({ status: 410 });
    await expect(lifecycle.invokeRegistered(bobBody, bob, async () => undefined)).resolves.toMatchObject({ status: 200 });
    expect(runtimeSessionId(alice)).not.toBe(runtimeSessionId(bob));
  });

  it('does not wait for another filing identity or stop its physical Sandbox', async () => {
    const alice = { session_id: 'shared-session-id', filing_user_id: 'filing-alice', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000002' };
    const bob = { session_id: 'shared-session-id', filing_user_id: 'filing-bob', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000003' };
    const bobHeaders = deferred<Response>();
    const invoke = vi.fn((body: string) => body === 'bob' ? bobHeaders.promise : Promise.resolve(new Response('alice answer')));
    const stop = vi.fn(async () => undefined);
    const lifecycle = sessionLifecycle({ label: 'AgentCore upstream', invoke }, stop);
    await lifecycle.invokeRegistered('alice', alice, async () => undefined);
    const bobTurn = lifecycle.invokeRegistered('bob', bob, async () => undefined);
    const stopping = lifecycle.stop(alice);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stop.mock.calls).toEqual([['runtime-00000000-0000-4000-8000-000000000002']]);
    expect(invoke.mock.calls).toEqual([
      ['alice', 'runtime-00000000-0000-4000-8000-000000000002', undefined],
      ['bob', 'runtime-00000000-0000-4000-8000-000000000003', undefined],
    ]);
    bobHeaders.resolve(new Response('bob answer'));
    expect(await (await bobTurn).text()).toBe('bob answer');
    await stopping;
  });

  it('drains only the deleted filing identity while another local producer keeps streaming', async () => {
    const alice = { session_id: 'shared-session-id', filing_user_id: 'filing-alice', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000002' };
    const bob = { session_id: 'shared-session-id', filing_user_id: 'filing-bob', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000003' };
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

  it('keeps ambiguous dispatch failures separate for colliding client Session IDs', async () => {
    const alice = { session_id: 'shared-session-id', filing_user_id: 'filing-alice', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000002' };
    const bob = { session_id: 'shared-session-id', filing_user_id: 'filing-bob', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000003' };
    const lifecycle = sessionLifecycle({
      label: 'AgentCore upstream',
      invoke: async () => { throw new Error('bob headers lost'); },
    }, async () => 'absent');
    await expect(lifecycle.invokeRegistered('bob', bob, async () => undefined)).rejects.toThrow('bob headers lost');

    await expect(lifecycle.stop(alice)).resolves.toBe('absent');
    await expect(lifecycle.stop(bob)).rejects.toThrow('bob headers lost');
  });

});


it('uses the durable opaque target even when a logical ID equals a legacy physical target', async () => {
  const legacyPhysicalTarget = 'session-282076aaa1a2e054f6baa24fb8a8a70ff7c4752db6070b1318cc7bff29598c3c';
  const session = { ...SESSION, session_id: legacyPhysicalTarget };
  const invoke = vi.fn(async () => new Response('tracked answer'));
  const lifecycle = sessionLifecycle({ label: 'AgentCore', invoke }, async () => undefined);
  expect(await (await lifecycle.invokeRegistered('turn', session, async () => undefined)).text()).toBe('tracked answer');
  expect(invoke.mock.calls).toEqual([['turn', 'runtime-00000000-0000-4000-8000-000000000001', undefined]]);
  await expect(lifecycle.invokeRegistered('legacy', { session_id: session.runtime_binding, filing_user_id: 'legacy-user' }, async () => undefined)).rejects.toMatchObject({ status: 503, detail: 'Session Runtime binding is unproved' });
});

it('invokes a legacy continuation only through its opaque binding without accepting a clean-generation disguise', async () => {
  const continuation = { ...SESSION, runtime_generation: 'continuation-v1', legacy_settlement_unproved: true as const };
  const invoke = vi.fn(async () => new Response('continued'));
  const complete = vi.fn(async () => undefined);
  const lifecycle = sessionLifecycle({ label: 'local', invoke });
  const response = await lifecycle.invokeRegistered('{}', continuation, complete);
  expect(await response.text()).toBe('continued');
  expect(invoke).toHaveBeenCalledWith('{}', 'runtime-00000000-0000-4000-8000-000000000001', undefined);
  expect(complete).toHaveBeenCalledOnce();
  expect(() => runtimeSessionId({ ...continuation, runtime_generation: 'tracked-v1' })).toThrow('Session Runtime binding is unproved');
  expect(() => runtimeSessionId({ ...SESSION, runtime_generation: 'continuation-v1' })).toThrow('Session Runtime binding is unproved');
});
