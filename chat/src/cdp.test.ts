import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cdp } from './cdp.js';

/** A browser's CDP endpoint that lists `targets` and attaches to any target it is given. */
function browserWithTargets(targets: { targetId: string; type: string }[]) {
  const attached: unknown[] = [];
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data: string) {
      const { id, method, params } = JSON.parse(data) as { id: number; method: string; params?: { targetId?: string } };
      if (method === 'Target.attachToTarget') attached.push(params?.targetId);
      const result = method === 'Target.getTargets' ? { targetInfos: targets } : { sessionId: 'page-session' };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) })));
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  return { attached };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attaching to the auth browser page', () => {
  it('attaches to the first page target, past the targets that are not pages', async () => {
    const { attached } = browserWithTargets([
      { targetId: 'worker-1', type: 'service_worker' },
      { targetId: 'page-1', type: 'page' },
      { targetId: 'page-2', type: 'page' },
    ]);
    const cdp = await Cdp.connect('ws://auth-browser');

    await expect(cdp.attachToPage()).resolves.toBe('page-session');
    expect(attached).toEqual(['page-1']);
  });

  it('fails loud when the browser has no page target', async () => {
    const { attached } = browserWithTargets([{ targetId: 'worker-1', type: 'service_worker' }]);
    const cdp = await Cdp.connect('ws://auth-browser');

    await expect(cdp.attachToPage()).rejects.toThrow(new Error('No page target found in auth browser session'));
    expect(attached).toEqual([]);
  });
});
