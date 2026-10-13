import { describe, expect, it } from 'vitest';

import { initializeAccountSession } from './account-session';

/** The URL a fetch was called with. */
const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

describe('initializeAccountSession', () => {
  it('requests the account session with credentials', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([urlOf(input), init]);
      return Response.json({ accountId: 'acct-1', authenticated: false });
    };

    await expect(initializeAccountSession({
      chatServiceUrl: 'http://localhost:8123',
      fetchImpl,
    })).resolves.toEqual({ status: 'ready', accountId: 'acct-1' });

    expect(calls).toEqual([
      [
        'http://localhost:8123/account/session',
        { credentials: 'include', cache: 'no-store' },
      ],
    ]);
  });

  it('fails loud on a session that names no account', async () => {
    await expect(initializeAccountSession({
      chatServiceUrl: 'http://localhost:8123',
      fetchImpl: async () => Response.json({ authenticated: false }),
    })).rejects.toThrow('Account session response is invalid');
  });

  it('fails loud on a 503 detail, including an unconfigured account store, current or pre-port', async () => {
    for (const detail of [
      'BOTCUBE_CHAT_TABLE is required',
      'TEMPLATEBOT_ACCOUNT_STORE_PATH is required',
      'AGENTCORE_RUNTIME_ARN is not configured',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- test cases run one at a time
      await expect(initializeAccountSession({
        chatServiceUrl: 'http://localhost:8123',
        fetchImpl: async () => Response.json({ detail }, { status: 503 }),
      })).rejects.toThrow('Account session failed: 503');
    }
  });

  it('reports a parked production from the exact parked response', async () => {
    const fetchImpl = async () => Response.json({ status: 'parked' }, { status: 503 });

    await expect(initializeAccountSession({
      chatServiceUrl: 'http://localhost:8123',
      fetchImpl,
    })).resolves.toEqual({ status: 'parked' });
  });

  it('does not mistake other parked-looking failures for a parked production', async () => {
    for (const response of [
      Response.json({ status: 'parked' }, { status: 502 }),
      Response.json({ status: 'unavailable' }, { status: 503 }),
      new Response('{"status":"parked"', { status: 503 }),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- test cases run one at a time
      await expect(initializeAccountSession({
        chatServiceUrl: 'http://localhost:8123',
        fetchImpl: async () => response,
      })).rejects.toThrow('Account session failed');
    }
  });

  it('fails for other account session errors', async () => {
    const fetchImpl = async () => new Response(null, { status: 500 });

    await expect(initializeAccountSession({
      chatServiceUrl: 'http://localhost:8123',
      fetchImpl,
    })).rejects.toThrow('Account session failed: 500');
  });
});
