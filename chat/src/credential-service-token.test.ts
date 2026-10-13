import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signCredentialServiceInvocation, verifyCredentialServiceInvocation } from './credential-service-token.js';

// Fake timers outlive a test that doesn't restore them.
afterEach(() => vi.useRealTimers());

describe('a Credential Service invocation token', () => {
  it('is byte-identical to the Python signer, so its verifier accepts it', () => {
    // sign_credential_service_invocation('secret', 'acct_tëst12345', 'session-1', now=1790000000)
    expect(signCredentialServiceInvocation('secret', 'acct_tëst12345', 'session-1', { now: 1_790_000_000 })).toBe(
      'v1.eyJhY2NvdW50X2lkIjoiYWNjdF90XHUwMGVic3QxMjM0NSIsImV4cGlyZXNfYXQiOjE3OTAwMDA2MDAsInNlc3Npb25faWQiOiJzZXNzaW9uLTEifQ.NvZNaeu9Iog-lBrTt5jsz_861TIxeLR8BkkJKXiTD6I',
    );
  });

  it('carries a scope byte-identically to the Python signer', () => {
    // sign_credential_service_invocation('secret', 'acct_tëst12345', 'glink_1', scope='credential_capture', now=1790000000)
    expect(
      signCredentialServiceInvocation('secret', 'acct_tëst12345', 'glink_1', {
        scope: 'credential_capture',
        now: 1_790_000_000,
      }),
    ).toBe(
      'v1.eyJhY2NvdW50X2lkIjoiYWNjdF90XHUwMGVic3QxMjM0NSIsImV4cGlyZXNfYXQiOjE3OTAwMDA2MDAsInNjb3BlIjoiY3JlZGVudGlhbF9jYXB0dXJlIiwic2Vzc2lvbl9pZCI6ImdsaW5rXzEifQ.zn03tn4lSCltA4cVHOSbrVZvGEsANCb1vyfMMz4CPlI',
    );
  });

  it('expires ten minutes after the current time when no time is given', () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    expect(signCredentialServiceInvocation('secret', 'acct_tëst12345', 'session-1')).toBe(
      'v1.eyJhY2NvdW50X2lkIjoiYWNjdF90XHUwMGVic3QxMjM0NSIsImV4cGlyZXNfYXQiOjE3OTAwMDA2MDAsInNlc3Npb25faWQiOiJzZXNzaW9uLTEifQ.NvZNaeu9Iog-lBrTt5jsz_861TIxeLR8BkkJKXiTD6I',
    );
  });

  it('binds the validated provider and wire model byte-identically to the Python signer', () => {
    const token = 'v1.eyJhY2NvdW50X2lkIjoiYWNjdF90XHUwMGVic3QxMjM0NSIsImV4cGlyZXNfYXQiOjE3OTAwMDA2MDAsIm1vZGVsX2lkIjoiZ3B0LTUuNi1zb2wiLCJtb2RlbF9wcm92aWRlciI6Im9wZW5haSIsInNlc3Npb25faWQiOiJzZXNzaW9uLTEifQ.9w4MmP0VL4nxfHVmhuQ79LX9NT34quSW98ZcEjl1PzY';
    expect(signCredentialServiceInvocation('secret', 'acct_tëst12345', 'session-1', {
      now: 1_790_000_000, model: { provider: 'openai', id: 'gpt-5.6-sol' },
    })).toBe(token);
    expect(verifyCredentialServiceInvocation('secret', token, 1_790_000_000)).toEqual({
      accountId: 'acct_tëst12345', sessionId: 'session-1', scope: undefined,
      modelProvider: 'openai', modelId: 'gpt-5.6-sol',
    });
  });

  it.each([{ provider: '', id: 'gpt-5.6-sol' }, { provider: 'openai', id: '' }])(
    'refuses an empty model binding (%j)', (model) => {
      expect(() => signCredentialServiceInvocation('secret', 'acct-1', 'session-1', { model })).toThrow(
        'CredentialService model binding must not be empty',
      );
    },
  );
});

/** A v1 token over any payload, signed with `secret`. */
function tokenOver(body: unknown, secret = 'secret') {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

describe('verifying a Credential Service invocation token', () => {
  // The Python signer's token for acct_tëst12345 / glink_1, scope credential_capture, expiring at 1790000600.
  const PYTHON_TOKEN =
    'v1.eyJhY2NvdW50X2lkIjoiYWNjdF90XHUwMGVic3QxMjM0NSIsImV4cGlyZXNfYXQiOjE3OTAwMDA2MDAsInNjb3BlIjoiY3JlZGVudGlhbF9jYXB0dXJlIiwic2Vzc2lvbl9pZCI6ImdsaW5rXzEifQ.zn03tn4lSCltA4cVHOSbrVZvGEsANCb1vyfMMz4CPlI';

  it('accepts the Python signer\'s token until it expires', () => {
    expect(verifyCredentialServiceInvocation(' secret ', ` ${PYTHON_TOKEN} `, 1_790_000_600.9)).toEqual({
      accountId: 'acct_tëst12345',
      sessionId: 'glink_1',
      scope: 'credential_capture',
    });
    expect(verifyCredentialServiceInvocation('secret', PYTHON_TOKEN, 1_790_000_601)).toBeNull();
  });

  it('expires at the current time when no time is given', () => {
    vi.useFakeTimers({ now: 1_790_000_601_000 });
    expect(verifyCredentialServiceInvocation('secret', PYTHON_TOKEN)).toBeNull();
  });

  it('accepts a token with no scope', () => {
    const token = tokenOver({ account_id: ' acct_1 ', session_id: ' run_1 ', expires_at: 2_000 });
    expect(verifyCredentialServiceInvocation('secret', token, 1_000)).toEqual({
      accountId: 'acct_1',
      sessionId: 'run_1',
      scope: undefined,
    });
  });

  it.each([
    ['another secret', PYTHON_TOKEN, 'other'],
    ['an empty secret', tokenOver({ account_id: 'a', session_id: 's', expires_at: 2_000 }, ''), ' '],
    ['another version', PYTHON_TOKEN.replace(/^v1/, 'v2'), 'secret'],
    ['a missing signature', PYTHON_TOKEN.split('.').slice(0, 2).join('.'), 'secret'],
    ['an extra segment', `${PYTHON_TOKEN}.x`, 'secret'],
    ['a truncated signature', PYTHON_TOKEN.slice(0, -1), 'secret'],
    ['a non-JSON payload', tokenOver('not json'), 'secret'],
    ['a JSON null payload', tokenOver('null'), 'secret'],
    ['a blank account', tokenOver({ account_id: ' ', session_id: 's', expires_at: 2_000 }), 'secret'],
    ['a missing Session', tokenOver({ account_id: 'a', expires_at: 2_000 }), 'secret'],
    ['a blank scope', tokenOver({ account_id: 'a', session_id: 's', scope: ' ', expires_at: 2_000 }), 'secret'],
    ['a non-string scope', tokenOver({ account_id: 'a', session_id: 's', scope: 1, expires_at: 2_000 }), 'secret'],
    ['a missing model id', tokenOver({ account_id: 'a', session_id: 's', expires_at: 2_000, model_provider: 'openai' }), 'secret'],
    ['a missing model provider', tokenOver({ account_id: 'a', session_id: 's', expires_at: 2_000, model_id: 'gpt-5.6-sol' }), 'secret'],
    ['a blank model id', tokenOver({ account_id: 'a', session_id: 's', expires_at: 2_000, model_provider: 'openai', model_id: ' ' }), 'secret'],
    ['a non-string model provider', tokenOver({ account_id: 'a', session_id: 's', expires_at: 2_000, model_provider: 1, model_id: 'gpt-5.6-sol' }), 'secret'],
    ['a fractional expiry', tokenOver({ account_id: 'a', session_id: 's', expires_at: 2_000.5 }), 'secret'],
    ['a string expiry', tokenOver({ account_id: 'a', session_id: 's', expires_at: '2000' }), 'secret'],
  ])('refuses a token with %s', (_label, token, secret) => {
    expect(verifyCredentialServiceInvocation(secret, token, 1_000)).toBeNull();
  });
});


describe('Credential Service invocation lifetimes', () => {
  it.each([undefined, 'credential_capture', 'credential_ingest', 'credential_revocation', 'session_seed'])(
    'keeps the default ten-minute bound for scope %s', (scope) => {
      const token = signCredentialServiceInvocation('synthetic-secret', 'account-synthetic', 'session-synthetic', {
        scope, now: 0,
      });
      const invocation = verifyCredentialServiceInvocation('synthetic-secret', token, 600);
      expect(invocation !== null).toBe(true);
      expect(invocation?.accountId).toBe('account-synthetic');
      expect(invocation?.sessionId).toBe('session-synthetic');
      expect(invocation?.scope).toBe(scope);
      expect(verifyCredentialServiceInvocation('synthetic-secret', token, 601) === null).toBe(true);
    },
  );

  it('honors a shorter explicit lifetime without weakening expiry', () => {
    const token = signCredentialServiceInvocation('synthetic-secret', 'account-synthetic', 'session-synthetic', {
      now: 0, ttlSeconds: 1,
    });
    expect(verifyCredentialServiceInvocation('synthetic-secret', token, 1)?.accountId).toBe('account-synthetic');
    expect(verifyCredentialServiceInvocation('synthetic-secret', token, 2) === null).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, 0.5, 600.5, Number.MAX_SAFE_INTEGER + 1, 3601])(
    'rejects an invalid explicit lifetime %s', (ttlSeconds) => {
      expect(() => signCredentialServiceInvocation('synthetic-secret', 'account-synthetic', 'session-synthetic', {
        now: 0, ttlSeconds,
      })).toThrow('CredentialService invocation lifetime must be a positive integer at most 3600 seconds');
    },
  );
});
