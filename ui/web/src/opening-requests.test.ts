import { fetchMainChat } from './app/conversations';
import { initializeAccountSession } from './account-session';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startOpeningRequests, peekOpeningResponse, takeOpeningResponse, discardOpeningResponse } from './opening-requests';

beforeEach(() => { vi.stubGlobal('window', { location: { pathname: '/', search: '' } }); });
afterEach(() => { vi.unstubAllGlobals(); });

it('two tabs opening before the first Guest cookie arrives get the same account', async () => {
  let finishFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => { finishFirst = resolve; });
  let cookie: string | undefined;
  let guests = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.endsWith('/account/session')) return Response.json({ messages: [] });
    const accountId = cookie ?? `guest-${++guests}`;
    if (accountId === 'guest-1') await firstResponse;
    cookie = accountId;
    return Response.json({ accountId, authenticated: false });
  });
  const chatServiceUrl = 'https://chat.test';
  startOpeningRequests(chatServiceUrl);
  const first = initializeAccountSession({ chatServiceUrl });
  vi.stubGlobal('window', { location: { pathname: '/', search: '' } });
  startOpeningRequests(chatServiceUrl);
  const second = initializeAccountSession({ chatServiceUrl });
  finishFirst();

  await expect(Promise.all([first, second])).resolves.toMatchObject([
    { accountId: 'guest-1', guest: true }, { accountId: 'guest-1', guest: true },
  ]);
});

it('starts session and Main together before either response, and consumes each only once', async () => {
  let finish!: (response: Response) => void;
  const session = new Promise<Response>((resolve) => { finish = resolve; });
  const fetch = vi.fn((url: string) => url.endsWith('/account/session') ? session : Promise.resolve(Response.json({ messages: [] })));
  vi.stubGlobal('fetch', fetch);
  startOpeningRequests('https://chat.test');
  await Promise.resolve();
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(['https://chat.test/account/session', 'https://chat.test/main-chat']);
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

it.each([{ pathname: '/', search: '?chat=side' }, { pathname: '/browser-view', search: '' }])('does not replay Main at $pathname with search "$search"', async (location) => {
  const fetch = vi.fn(() => Promise.resolve(Response.json({})));
  vi.stubGlobal('window', { location });
  vi.stubGlobal('fetch', fetch);
  startOpeningRequests('https://chat.test');
  await Promise.resolve();
  expect(fetch.mock.calls).toEqual(location.pathname === '/'
    ? [['https://chat.test/account/session', { credentials: 'include', cache: 'no-store' }]] : []);
});

it('creates a first anonymous account before retrying its unauthorized opening transcript', async () => {
  const boot = vi.fn((url: string) => Promise.resolve(url.includes('/main-chat') ? new Response(null, {status: 401}) : Response.json({accountId: 'anonymous'})));
  vi.stubGlobal('fetch', boot);
  startOpeningRequests('https://chat.test');
  await initializeAccountSession({chatServiceUrl: 'https://chat.test'});
  const fresh = vi.fn(async () => Response.json({id: 'main', messages: [], running: false}));
  expect(await fetchMainChat({chatServiceUrl: 'https://chat.test', fetchImpl: fresh})).toMatchObject({id: 'main', messages: []});
  expect(fresh).toHaveBeenCalledOnce();
});

it('propagates opening transcript errors and discards transcript when account startup failed', async () => {
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


it('shares a readable preview without consuming the live response or issuing another request', async () => {
  const body = { id: 'main', messages: [{ id: 'answer', role: 'assistant', content: 'Saved answer' }] };
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetch);
  startOpeningRequests('https://chat.test');
  const preview = await peekOpeningResponse('https://chat.test/main-chat');
  expect(preview).not.toBeNull();
  if (preview === null || 'error' in preview) throw new Error('Expected the opening response');
  expect(await preview.response.json()).toEqual(body);
  expect(await (await takeOpeningResponse('https://chat.test/main-chat'))?.json()).toEqual(body);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('retains a preview error until the authenticated consumer can handle it', async () => {
  const failure = new Error('offline');
  vi.stubGlobal('fetch', async () => { throw failure; });
  startOpeningRequests('https://chat.test');
  expect(await peekOpeningResponse('https://chat.test/main-chat')).toEqual({ error: failure });
  await expect(takeOpeningResponse('https://chat.test/main-chat')).rejects.toBe(failure);
});
