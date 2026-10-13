import { describe, expect, it } from 'vitest';
import { agentComputerTokens } from './agent-computer-token.js';

const NOW = 1_800_000_000_000;

describe('agentComputerTokens', () => {
  it('verifies the Session it issued a token for, for an hour', () => {
    const tokens = agentComputerTokens(Buffer.alloc(32, 1));
    const token = tokens.issue('acct-1', 'thread-1', NOW);
    expect(tokens.verify(token, NOW)).toEqual({ accountId: 'acct-1', threadId: 'thread-1' });
    expect(tokens.verify(token, NOW + 3_599_000)).toEqual({ accountId: 'acct-1', threadId: 'thread-1' });
    expect(tokens.verify(token, NOW + 3_600_000)).toBeNull();
  });

  it('refuses a token another key signed', () => {
    const token = agentComputerTokens(Buffer.alloc(32, 2)).issue('acct-1', 'thread-1', NOW);
    expect(agentComputerTokens(Buffer.alloc(32, 1)).verify(token, NOW)).toBeNull();
  });

  it('refuses a token whose Session was changed', () => {
    const tokens = agentComputerTokens(Buffer.alloc(32, 1));
    const [, signature] = tokens.issue('acct-1', 'thread-1', NOW).split('.');
    const forged = Buffer.from(JSON.stringify({ accountId: 'acct-2', threadId: 'thread-1', expiresAt: NOW })).toString(
      'base64url',
    );
    expect(tokens.verify(`${forged}.${signature}`, NOW)).toBeNull();
  });

  it.each(['', 'no-dot', '.', 'a.b'])('refuses the malformed token %j', (token) => {
    expect(agentComputerTokens(Buffer.alloc(32, 1)).verify(token, NOW)).toBeNull();
  });
});
