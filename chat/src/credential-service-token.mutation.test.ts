import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { signCredentialServiceInvocation, verifyCredentialServiceInvocation } from './credential-service-token.js';

afterEach(() => vi.useRealTimers());

/** Sign a fixture payload independently, allowing noncanonical claims from another signer. */
function tokenOver(body: Record<string, string | number>): string {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', 'secret').update(payload).digest('base64url')}`;
}

it('canonicalizes padded model claims exactly like the Python signer', () => {
  // Existing Python-signer fixture for the canonical account, Session and model.
  expect(signCredentialServiceInvocation('secret', 'acct_tëst12345', 'session-1', {
    now: 1_790_000_000, model: { provider: ' openai ', id: ' gpt-5.6-sol ' },
  })).toBe('v1.eyJhY2NvdW50X2lkIjoiYWNjdF90XHUwMGVic3QxMjM0NSIsImV4cGlyZXNfYXQiOjE3OTAwMDA2MDAsIm1vZGVsX2lkIjoiZ3B0LTUuNi1zb2wiLCJtb2RlbF9wcm92aWRlciI6Im9wZW5haSIsInNlc3Npb25faWQiOiJzZXNzaW9uLTEifQ.9w4MmP0VL4nxfHVmhuQ79LX9NT34quSW98ZcEjl1PzY');
});

it.each([{ provider: '   ', id: 'gpt-5.6-sol' }, { provider: 'openai', id: '   ' }])(
  'rejects a whitespace-only model binding (%j)', (model) => {
    expect(() => signCredentialServiceInvocation('secret', 'acct-1', 'session-1', { model }))
      .toThrow('CredentialService model binding must not be empty');
  },
);

it('normalizes signed scope and model claims before returning them', () => {
  const token = tokenOver({
    account_id: 'acct-1', session_id: 'session-1', scope: ' credential_capture ',
    model_provider: ' openai ', model_id: ' gpt-5.6-sol ', expires_at: 2_000,
  });
  expect(verifyCredentialServiceInvocation('secret', token, 1_000)).toEqual({
    accountId: 'acct-1', sessionId: 'session-1', scope: 'credential_capture',
    modelProvider: 'openai', modelId: 'gpt-5.6-sol',
  });
});

it('accepts a still-live token using the current clock by default', () => {
  vi.useFakeTimers({ now: 1_790_000_000_000 });
  const token = tokenOver({ account_id: 'acct-1', session_id: 'session-1', expires_at: 1_790_000_600 });
  expect(verifyCredentialServiceInvocation('secret', token)).toEqual({
    accountId: 'acct-1', sessionId: 'session-1', scope: undefined,
  });
});
