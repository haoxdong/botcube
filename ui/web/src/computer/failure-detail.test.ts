import { describe, expect, it } from 'vitest';
import { failureDetail } from './failure-detail';

describe('the reason a service refused a request', () => {
  it.each([
    ['a detail string', { detail: 'The provider did not accept that username and password' }, 'The provider did not accept that username and password'],
    ['a coded detail, by its message', { detail: { code: 'sheet_key_rotated', message: 'Open the Sign-in Sheet again.' } }, 'Open the Sign-in Sheet again.'],
    ['no reason, as the fallback and status', { detail: { code: 'sheet_key_unavailable' } }, 'Sign-in failed: 400'],
  ])('reads %s', async (_, body, reason) => {
    await expect(failureDetail(Response.json(body, { status: 400 }), 'Sign-in failed')).resolves.toBe(reason);
  });
});
