import { fetchMainChat } from './app/conversations';
import { initializeAccountSession } from './account-session';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startOpeningRequests, takeOpeningResponse, discardOpeningResponse } from './opening-requests';

beforeEach(() => { vi.stubGlobal('window', { location: { pathname: '/', search: '' } }); });
afterEach(() => { vi.unstubAllGlobals(); });

it('starts session and Main together before either response, and consumes each only once', async () => {
  let finish!: (response: Response) => void;
  const session = new Promise<Response>((resolve) => { finish = resolve; });
  const fetch = vi.fn((url: string) => url.endsWith('/account/session') ? session : Promise.resolve(Response.json({ messages: [] })));
  vi.stubGlobal('fetch', fetch);
  startOpeningRequests('https://chat.test');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://chat.test/account/session', 'https://chat.test/main-chat']);
  expect(fetch).toHaveBeenCalledWith('https://chat.test/account/session', { credentials: 'include', cache: 'no-store' });
  expect(fetch).toHaveBeenCalledWith('https://chat.test/main-chat', { credentials: 'include', cache: 'no-store' });
  const pending = takeOpeningResponse('https://chat.test/account/session');
  expect(takeOpeningResponse('https://chat.test/account/session')).toBeNull();
  finish(Response.json({ accountId: 'owner' }));
  expect(await (await pending)?.json()).toEqual({ accountId: 'owner' });
  expect(await (await takeOpeningResponse('https://chat.test/main-chat'))?.json()).toEqual({ messages: [] });
  expect(takeOpeningResponse('https://chat.test/main-chat')).toBeNull();
});

it('retains a rejected opening read for its consumer without starting another request', async () => {
  const failure = new Error('offline');
  vi.stubGlobal('fetch', () => Promise.reject(failure));
  startOpeningRequests('https://chat.test');
  await expect(takeOpeningResponse('https://chat.test/main-chat')).rejects.toBe(failure);
});

it('does not replay Main for a Side Chat link or a browser-view window', () => {
  for (const location of [{pathname: '/', search: '?chat=side'}, {pathname: '/browser-view', search: ''}]) {
    const window = {location};
    const fetch = vi.fn(() => Promise.resolve(Response.json({})));
    vi.stubGlobal('window', window);
    vi.stubGlobal('fetch', fetch);
    startOpeningRequests('https://chat.test');
    expect(fetch.mock.calls).toEqual(location.pathname === '/'
      ? [['https://chat.test/account/session', { credentials: 'include', cache: 'no-store' }]] : []);
  }
});

it('creates a first anonymous account before retrying its unauthorized opening history', async () => {
  const boot = vi.fn((url: string) => Promise.resolve(url.includes('/main-chat') ? new Response(null, {status: 401}) : Response.json({accountId: 'anonymous'})));
  vi.stubGlobal('fetch', boot);
  startOpeningRequests('https://chat.test');
  await initializeAccountSession({chatServiceUrl: 'https://chat.test'});
  const fresh = vi.fn(async () => Response.json({id: 'main', messages: [], running: false}));
  expect(await fetchMainChat({chatServiceUrl: 'https://chat.test', fetchImpl: fresh})).toMatchObject({id: 'main', messages: []});
  expect(fresh).toHaveBeenCalledOnce();
});

it('propagates opening history errors and discards history when account startup failed', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, {status: 503})));
  startOpeningRequests('https://chat.test');
  const fresh = vi.fn();
  await expect(fetchMainChat({chatServiceUrl: 'https://chat.test', fetchImpl: fresh})).rejects.toMatchObject({status: 503});
  expect(fresh).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({})));
  startOpeningRequests('https://chat.test');
  discardOpeningResponse('https://chat.test/main-chat');
  expect(takeOpeningResponse('https://chat.test/main-chat')).toBeNull();
});
