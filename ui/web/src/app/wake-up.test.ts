import { describe, expect, it } from 'vitest';
import { minutesLeft, untilLive, wake, wakeLapsed, WAKE_POLL_MS } from './wake-up';

const url = 'https://api.example.com';
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Wake up', () => {
  it('asks the parked Worker, and presses with a POST', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${init?.method} ${input instanceof Request ? input.url : input.toString()}`);
      return answer(200, init?.method === 'POST' ? { state: 'waking', since: '2026-11-04T05:00:00.000Z' } : { state: 'parked' });
    }) as typeof fetch;

    expect(await wake(url, 'GET', fetchImpl)).toEqual({ state: 'parked' });
    expect(await wake(url, 'POST', fetchImpl)).toEqual({ state: 'waking', since: '2026-11-04T05:00:00.000Z' });
    expect(asked).toEqual([`GET ${url}/production/wake`, `POST ${url}/production/wake`]);
  });

  it('says when the daily limit is reached', async () => {
    expect(await wake(url, 'POST', async () => answer(200, { state: 'limit', limit: 20 }))).toEqual({ state: 'limit', limit: 20 });
  });

  it('fails loud on a refused or unknown answer', async () => {
    await expect(wake(url, 'POST', async () => answer(500, { message: 'Internal Server Error' }))).rejects.toThrow('Wake up failed: 500');
    await expect(wake(url, 'GET', async () => answer(200, { state: 'asleep' }))).rejects.toThrow('Wake up answered an unknown state');
  });

  it('counts down the measured unpark, never above it or below a minute', () => {
    const since = '2026-11-04T05:00:00.000Z';
    expect(minutesLeft(since, Date.parse(since) - 5_000)).toBe(12);
    expect(minutesLeft(since, Date.parse(since))).toBe(12);
    expect(minutesLeft(since, Date.parse(since) + 10.5 * 60_000)).toBe(2);
    expect(minutesLeft(since, Date.parse(since) + 20 * 60_000)).toBe(1);
  });

  it('waits until the account session is served again, through the parked answer and unpark\'s network errors and 5xx', async () => {
    const answers: (Response | TypeError)[] = [answer(503, { status: 'parked' }), new TypeError('fetch failed'), answer(502, { message: 'Bad Gateway' }), answer(200, { accountId: 'account-1' })];
    const pauses: number[] = [];
    const fetchImpl = async () => {
      const next = answers.shift();
      if (next instanceof TypeError) throw next;
      return next ?? answer(200, { accountId: 'account-1' });
    };

    await untilLive(url, fetchImpl, async (ms) => { pauses.push(ms); });

    expect(answers).toEqual([]);
    expect(pauses).toEqual([WAKE_POLL_MS, WAKE_POLL_MS, WAKE_POLL_MS]);
  });

  it('fails loud on any other account session answer while waiting', async () => {
    await expect(untilLive(url, async () => answer(403, { message: 'Forbidden' }), async () => undefined)).rejects.toThrow('Account session failed: 403');
  });

  it('notices a wake that lapsed with production still parked, and not one under way or done', async () => {
    expect(await wakeLapsed(url, async () => answer(200, { state: 'parked' }))).toBe(true);
    expect(await wakeLapsed(url, async () => answer(200, { state: 'waking', since: '2026-11-04T05:00:00.000Z' }))).toBe(false);
    expect(await wakeLapsed(url, async () => answer(404, { message: 'Not Found' }))).toBe(false);
    expect(await wakeLapsed(url, async () => { throw new TypeError('fetch failed'); })).toBe(false);
  });
});
