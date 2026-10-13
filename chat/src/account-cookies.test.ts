import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { accountCookies } from './account-cookies.js';

const app = new Hono().get('/', (c) => {
  accountCookies('bot').setAccount(c, 'acct_1');
  return c.body(null, 204);
});

async function isSecure(url: string, forwardedProto?: string): Promise<boolean> {
  const response = await app.request(url, {
    headers: forwardedProto === undefined ? {} : { 'x-forwarded-proto': forwardedProto },
  });
  return response.headers.getSetCookie().some((cookie) => cookie.includes('; Secure'));
}

describe('a cookie the Chat Service sets', () => {
  it.each([
    ['https', true],
    [' HTTPS , http', true],
    ['http, https', false],
    ['http', false],
  ])('behind a proxy that forwarded %j is Secure: %s', async (forwardedProto, secure) => {
    expect(await isSecure('http://bot.test/', forwardedProto)).toBe(secure);
  });

  it('is Secure only on an https URL when no proxy forwarded a protocol', async () => {
    expect(await isSecure('http://bot.test/')).toBe(false);
    expect(await isSecure('https://bot.test/')).toBe(true);
  });
});
