import { afterEach, describe, expect, it } from 'vitest';

import { buildBrowserLiveViewUrl, fetchBrowserLiveViewSignedUrl } from './browser-live-view-url';

const originalChatServiceUrl = process.env.NEXT_PUBLIC_CHAT_SERVICE_URL;

afterEach(() => {
  if (originalChatServiceUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CHAT_SERVICE_URL;
  } else {
    process.env.NEXT_PUBLIC_CHAT_SERVICE_URL = originalChatServiceUrl;
  }
});

describe('browser live view URL', () => {
  it('targets the configured public service origin', () => {
    process.env.NEXT_PUBLIC_CHAT_SERVICE_URL = 'https://api.templatebot.com/';

    expect(buildBrowserLiveViewUrl('browser-session-123')).toBe(
      'https://api.templatebot.com/browser-live-view-url?session_id=browser-session-123',
    );
  });

  it('escapes reserved session id characters for the service request', () => {
    expect(buildBrowserLiveViewUrl('session/with?reserved', 'https://api.templatebot.com')).toBe(
      'https://api.templatebot.com/browser-live-view-url?session_id=session%2Fwith%3Freserved',
    );
  });
});

describe('fetchBrowserLiveViewSignedUrl', () => {
  it('sends account cookies so gated auth-browser sessions can be signed', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ signedUrl: 'https://signed.example/live-view' });
    }) as typeof fetch;

    await expect(fetchBrowserLiveViewSignedUrl('browser-session-123', {
      chatServiceUrl: 'https://api.templatebot.com',
      fetchImpl,
    })).resolves.toBe('https://signed.example/live-view');

    expect(calls).toEqual([{
      url: 'https://api.templatebot.com/browser-live-view-url?session_id=browser-session-123',
      init: expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    }]);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = (async () => Response.json({ detail: 'nope' }, { status: 401 })) as typeof fetch;

    await expect(fetchBrowserLiveViewSignedUrl('browser-session-123', {
      chatServiceUrl: 'https://api.templatebot.com',
      fetchImpl,
    })).rejects.toThrow('Live view URL request failed with 401');
  });

  it('throws when the response omits signedUrl', async () => {
    const fetchImpl = (async () => Response.json({})) as typeof fetch;

    await expect(fetchBrowserLiveViewSignedUrl('browser-session-123', {
      chatServiceUrl: 'https://api.templatebot.com',
      fetchImpl,
    })).rejects.toThrow('Live view URL response did not include signedUrl');
  });
});
