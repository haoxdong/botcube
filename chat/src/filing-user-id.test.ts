import { expect, it } from 'vitest';
import { filingUserId } from './filing-user-id.js';

// Values from the Harness half, botcube_cartridge.filing_user_id.
it('is the account ID in UTF-8 hex', () => {
  expect(filingUserId('template', 'acct_tëst12345')).toBe('template_616363745f74c3ab73743132333435');
});

it('is a SHA-256 when the hex would be too long', () => {
  expect(filingUserId('template', `acct_${'x'.repeat(200)}`)).toBe(
    'template_sha256_e34fa6ccd28671839789d00d5e97d09261afc9fe39da608bb3991a6eb080d51d',
  );
});

it('is refused for a blank account ID instead of filing under a shared identity', () => {
  // ADR 0068 §4: only the Chat Service resolves identity, and never to a shared one.
  expect(() => filingUserId('template', ' ')).toThrow('A filing user ID needs an Account ID');
});
