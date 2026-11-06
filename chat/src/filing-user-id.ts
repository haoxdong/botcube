import { createHash } from 'node:crypto';

const MAX_LENGTH = 255;

/**
 * The Harness user ID an Account's Sessions are filed under: `<prefix>_` + the ID's UTF-8 hex,
 * or `<prefix>_sha256_` + its SHA-256 when that is too long. The Harness's `filing_user_id`
 * (botcube_cartridge) derives the same ID, so the two must agree byte for byte.
 */
export function filingUserId(prefix: string, accountId: string): string {
  const raw = accountId.trim();
  if (!raw) throw new Error('A filing user ID needs an Account ID');
  const id = `${prefix}_${Buffer.from(raw, 'utf8').toString('hex')}`;
  if (id.length <= MAX_LENGTH) return id;
  return `${prefix}_sha256_${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}
