import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildDirectAgent, type SavedMessagesHttpAgent } from './conversations';
import { useTurn, type Turn } from './turn';

/** A Chat Service whose Turn streams the events a test sends, until it closes the stream. */
function chatService(threadId: string) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let runId = '';
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    runId = (JSON.parse(init?.body as string) as { runId: string }).runId;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const agent = buildDirectAgent({ chatServiceUrl: 'http://chat.test', threadId, messages: [], fetchImpl, onStopFailed: () => undefined });
  const send = async (event: Record<string, unknown>) => {
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ threadId, runId, ...event })}\n\n`));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  let run: Promise<unknown> = Promise.resolve();
  const start = async () => {
    await act(async () => {
      run = agent.runAgent().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const close = async () => {
    await act(async () => {
      stream.close();
      await run;
    });
  };
  return { agent, start, send, close };
}

const session = (agent: SavedMessagesHttpAgent, server: { runsOnServer?: boolean; stopOnServer?: (() => void) | null } = {}) =>
  ({ agent, runsOnServer: server.runsOnServer ?? false, stopOnServer: server.stopOnServer ?? null });

describe('useTurn', () => {
  it('keeps the Turn idle while CopilotKit connects the Session', async () => {
    const { agent } = chatService('t1');
    const phases: string[] = [];
    const unsubscribe = agent.subscribeTurn(() => phases.push(agent.getTurnPhase()));

    await agent.connectAgent();
    unsubscribe();

    expect(phases).toEqual(['idle']);
  });

  it('opens, starts, ends at the end event and goes idle at the stream close', async () => {
    const service = chatService('t1');
    const stopHere = vi.fn();
    const { result } = renderHook(() => useTurn({ ...session(service.agent), stopHere }));
    expect(result.current).toMatchObject({ phase: 'idle', stop: null });

    await service.start();
    expect(result.current).toMatchObject({ phase: 'opening', stop: stopHere });
    await service.send({ type: 'RUN_STARTED' });
    expect(result.current.phase).toBe('started');
    // The answer settles at RUN_FINISHED, while the stream stays open for the Turn's record.
    await service.send({ type: 'RUN_FINISHED' });
    expect(result.current).toMatchObject({ phase: 'ended', stop: stopHere });
    await service.close();
    expect(result.current).toMatchObject({ phase: 'idle', stop: null });
  });

  it('shows a finished reply as ended in a view mounted before the stream closes', async () => {
    const service = chatService('t1');
    const first = renderHook(() => useTurn(session(service.agent)));
    await service.start();
    await service.send({ type: 'RUN_STARTED' });
    await service.send({ type: 'RUN_FINISHED' });
    expect(first.result.current.phase).toBe('ended');
    first.unmount();

    const second = renderHook(() => useTurn(session(service.agent)));
    expect(second.result.current.phase).toBe('ended');
    await service.close();
    expect(second.result.current.phase).toBe('idle');
  });

  it('ends at a run error too', async () => {
    const service = chatService('t1');
    const { result } = renderHook(() => useTurn(session(service.agent)));
    await service.start();
    await service.send({ type: 'RUN_STARTED' });
    await service.send({ type: 'RUN_ERROR', message: 'The Turn ended.' });
    expect(result.current.phase).toBe('ended');
  });

  it('runs on the server with no stream here, stoppable once its run is known', () => {
    const service = chatService('t1');
    const stopOnServer = vi.fn();
    const { result, rerender } = renderHook<Turn, { runsOnServer: boolean; stopOnServer?: () => void }>((server) => useTurn(session(service.agent, server)), { initialProps: { runsOnServer: true } });
    expect(result.current).toMatchObject({ phase: 'onServer', stop: null });
    rerender({ runsOnServer: true, stopOnServer });
    expect(result.current).toMatchObject({ phase: 'onServer', stop: stopOnServer });
    rerender({ runsOnServer: false });
    expect(result.current).toMatchObject({ phase: 'idle', stop: null });
  });

  it('follows the stream here over the server record of the same Turn', async () => {
    const service = chatService('t1');
    const stopHere = vi.fn();
    const { result } = renderHook(() => useTurn({ ...session(service.agent, { runsOnServer: true, stopOnServer: () => undefined }), stopHere }));
    await service.start();
    await service.send({ type: 'RUN_STARTED' });
    expect(result.current).toMatchObject({ phase: 'started', stop: stopHere });
  });

  // A Turn running in one chat leaves another idle, so a send there starts a Turn rather than steering.
  it("reads the open Session's agent alone", async () => {
    const running = chatService('a');
    const other = chatService('b');
    const { result, rerender } = renderHook(({ agent }) => useTurn(session(agent)), { initialProps: { agent: running.agent } });
    await running.start();
    await running.send({ type: 'RUN_STARTED' });

    rerender({ agent: other.agent });
    expect(result.current).toMatchObject({ phase: 'idle', stop: null });
    rerender({ agent: running.agent });
    expect(result.current.phase).toBe('started');
  });

  it('holds an asked run opening until it streams, then follows its stream', async () => {
    const service = chatService('t1');
    const { result } = renderHook(() => useTurn(session(service.agent)));
    let streamNow!: () => void;
    const awaited = new Promise<void>((resolve) => { streamNow = resolve; });
    let asked!: Promise<void>;
    act(() => {
      asked = result.current.ask(async () => {
        await awaited;
        await service.agent.runAgent().catch(() => undefined);
      });
    });
    expect(result.current.phase).toBe('opening');

    await act(async () => {
      streamNow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await service.send({ type: 'RUN_STARTED' });
    await service.send({ type: 'RUN_FINISHED' });
    await service.close();
    await act(async () => { await asked; });
    expect(result.current.phase).toBe('idle');
  });

  it("keeps the next Session's Opening Turn pending when the previous request settles", async () => {
    const first = chatService('a');
    const second = chatService('b');
    const { result, rerender } = renderHook(({ agent }) => useTurn(session(agent)), { initialProps: { agent: first.agent } });
    const previous = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;

    act(() => { firstRequest = result.current.ask(() => previous.promise); });
    rerender({ agent: second.agent });
    expect(result.current.phase).toBe('idle');

    act(() => { secondRequest = result.current.ask(() => current.promise); });
    await act(async () => { previous.resolve(); await firstRequest; });
    expect(result.current.phase).toBe('opening');

    await act(async () => { current.resolve(); await secondRequest; });
    expect(result.current.phase).toBe('idle');
  });

  it('goes idle when an asked run fails before it streams', async () => {
    const service = chatService('t1');
    const { result } = renderHook(() => useTurn(session(service.agent)));
    await act(async () => {
      await result.current.ask(async () => { throw new Error('no models'); }).catch(() => undefined);
    });
    expect(result.current.phase).toBe('idle');
  });
});
