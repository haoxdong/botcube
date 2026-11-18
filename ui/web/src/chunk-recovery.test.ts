import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startChunkRecovery } from './chunk-recovery';

let events: EventTarget;
let reload: ReturnType<typeof vi.fn>;
let storage: Storage;

beforeEach(() => {
  events = new EventTarget();
  reload = vi.fn();
  storage = sessionStorage;
  storage.clear();
  vi.stubGlobal('window', Object.assign(events, { location: { reload }, sessionStorage: storage }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function chunkFailure() {
  return Object.assign(new Error('Failed to load chunk /_next/static/chunks/3tsz8lh-6sisl.js from module probe'), { name: 'ChunkLoadError' });
}

function report(error: unknown, type: 'error' | 'unhandledrejection' = 'error') {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, type === 'error' ? 'error' : 'reason', { value: error });
  events.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
}

it.each(['error', 'unhandledrejection'] as const)('reloads a missing lazy chunk reported through %s', (type) => {
  startChunkRecovery();
  report(chunkFailure(), type);
  expect(reload).toHaveBeenCalledOnce();
});

it('bounds recovery across repeated errors and page reloads', () => {
  startChunkRecovery();
  report(chunkFailure());
  report(chunkFailure());
  events = new EventTarget();
  vi.stubGlobal('window', Object.assign(events, { location: { reload }, sessionStorage: storage }));
  startChunkRecovery();
  report(chunkFailure());
  expect(reload).toHaveBeenCalledOnce();
});

it('leaves ordinary exceptions and non-error rejections visible without reloading', () => {
  startChunkRecovery();
  report(new Error('Render failed'));
  report('Loading chunk in user text', 'unhandledrejection');
  report(null, 'unhandledrejection');
  expect(reload).not.toHaveBeenCalled();
});

it('keeps the original error visible when storage cannot persist the reload bound', () => {
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } });
  startChunkRecovery();
  report(chunkFailure());
  expect(reload).not.toHaveBeenCalled();
});
